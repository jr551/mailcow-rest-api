'use strict';

const { request } = require('undici');
const { parseIcal } = require('../caldav-client');
const { badRequest, problem } = require('../errors');
const { problemSchema } = require('../schemas');
const { validateTargetUrl, createPinnedDispatcher } = require('../utils/ssrf-guard');

// A calendar feed is a public HTTPS URL. Nothing else was enforced: the
// stored URL was fetched verbatim from inside the Docker network, so
// http://10.0.0.5:6379/ or http://169.254.169.254/latest/meta-data/ were
// both reachable — and undici's connect errors, which name host, port and
// errno, were reflected straight back in the 502 detail. That combination is
// a port scanner with a readback channel. Validate on create, validate and
// pin on fetch, and keep upstream error text in the log only.
const FEED_SCHEMES = ['https:', 'http:'];

module.exports = async function calendarSubscriptionRoutes(app, { store }) {
    if (!store) {
        app.log.warn('calendar subscription routes disabled: store not available');
        return;
    }

    function requireUser(req) {
        const user = req.creds?.user;
        if (!user) throw problem(401, 'Unauthorized', 'Authentication required');
        return user;
    }

    app.get('/v1/me/calendar-subscriptions', {
        schema: {
            tags: ['calendar'],
            summary: 'List external calendar subscriptions',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        user: { type: 'string' },
                        subscriptions: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string' },
                                    name: { type: 'string' },
                                    url: { type: 'string' },
                                    color: { type: 'string' }
                                }
                            }
                        }
                    }
                }
            }
        }
    }, async (req) => {
        const user = requireUser(req);
        const subscriptions = store.list({ user });
        return { user, subscriptions };
    });

    app.post('/v1/me/calendar-subscriptions', {
        schema: {
            tags: ['calendar'],
            summary: 'Subscribe to an external ICS calendar',
            body: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'url'],
                properties: {
                    name: { type: 'string', maxLength: 200 },
                    url: { type: 'string', format: 'uri', maxLength: 2048 },
                    color: { type: 'string', maxLength: 20 }
                }
            },
            response: {
                201: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                        url: { type: 'string' },
                        color: { type: 'string' }
                    }
                },
                400: problemSchema
            }
        }
    }, async (req, reply) => {
        const user = requireUser(req);
        const { name, url, color } = req.body;
        if (!name.trim() || !url.trim()) throw badRequest('name and url are required');
        const check = validateTargetUrl(url.trim(), { schemes: FEED_SCHEMES });
        if (!check.ok) throw badRequest(`Invalid calendar URL: ${check.reason}`);
        const sub = store.create({ user, name: name.trim(), url: url.trim(), color });
        reply.code(201);
        return sub;
    });

    app.delete('/v1/me/calendar-subscriptions/:id', {
        schema: {
            tags: ['calendar'],
            summary: 'Remove a calendar subscription',
            response: {
                204: { type: 'null' },
                404: problemSchema
            }
        }
    }, async (req, reply) => {
        const user = requireUser(req);
        const id = decodeURIComponent(req.params.id);
        const removed = store.remove({ id, user });
        if (!removed) throw problem(404, 'Not Found', 'Subscription not found');
        reply.code(204).send();
    });

    app.get('/v1/me/calendar-subscriptions/:id/events', {
        schema: {
            tags: ['calendar'],
            summary: 'Fetch events from an external ICS calendar',
            querystring: {
                type: 'object',
                additionalProperties: false,
                required: ['start', 'end'],
                properties: {
                    start: { type: 'string', format: 'date-time' },
                    end: { type: 'string', format: 'date-time' }
                }
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        user: { type: 'string' },
                        subscription: { type: 'string' },
                        events: { type: 'array', items: { type: 'object', additionalProperties: true } }
                    }
                },
                404: problemSchema
            }
        }
    }, async (req) => {
        const user = requireUser(req);
        const id = decodeURIComponent(req.params.id);
        const sub = store.get({ id, user });
        if (!sub) throw problem(404, 'Not Found', 'Subscription not found');

        const { start, end } = req.query;
        const startDate = new Date(start);
        const endDate = new Date(end);
        if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
            throw badRequest('Invalid start or end date');
        }

        // Re-check on every fetch, not just at create time: the rules may
        // have tightened since, and DNS for a stored hostname can change.
        const check = validateTargetUrl(sub.url, { schemes: FEED_SCHEMES });
        if (!check.ok) {
            req.log.warn({ subId: sub.id, reason: check.reason }, 'calendar subscription URL rejected');
            throw problem(502, 'Bad Gateway', 'Calendar feed URL is not allowed');
        }

        let icalText;
        try {
            // Resolve, reject private answers, pin to the checked address.
            const dispatcher = await createPinnedDispatcher(sub.url);
            const { body, statusCode } = await request(sub.url, {
                method: 'GET',
                dispatcher,
                headers: { accept: 'text/calendar, application/octet-stream, */*' },
                signal: AbortSignal.timeout(30000)
            });
            if (statusCode >= 400) {
                const text = await body.text();
                throw new Error(`HTTP ${statusCode}: ${text.slice(0, 200)}`);
            }
            icalText = await body.text();
        } catch (err) {
            // The upstream message names hosts, ports and errno — exactly
            // what makes this a scanning oracle. Log it; return a generic
            // failure to the caller.
            req.log.warn({ subId: sub.id, err: err.message }, 'calendar feed fetch failed');
            throw problem(502, 'Bad Gateway', 'Could not fetch the calendar feed');
        }

        const parsed = parseIcal(icalText);
        const events = parsed
            .filter((e) => {
                if (!e.dtstart) return false;
                const evStart = new Date(e.dtstart);
                const evEnd = e.dtend ? new Date(e.dtend) : evStart;
                return evEnd >= startDate && evStart <= endDate;
            })
            .map((e) => ({
                uid: e.uid || `${id}-${e.dtstart}`,
                summary: e.summary || '(untitled)',
                description: e.description,
                location: e.location,
                dtstart: e.dtstart,
                dtend: e.dtend || e.dtstart,
                dtstamp: e.dtstamp
            }));

        return { user, subscription: id, events };
    });
};
