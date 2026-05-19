'use strict';

const config = require('../config');

const shortcutSchema = {
    type: 'object',
    properties: {
        title: { type: 'string' },
        url: { type: 'string' },
        mode: { type: 'string', enum: ['link', 'popup', 'embed'] },
        icon: { type: ['string', 'null'] },
        description: { type: ['string', 'null'] }
    }
};

module.exports = async function shortcutsRoutes(app) {
    // Public — the SPA fetches this before the user logs in (or right after)
    // so it can decide whether to show the Shortcuts sidebar section. No
    // sensitive data here: shortcuts are admin-baked URLs.
    app.get('/v1/me/shortcuts', {
        config: { public: true },
        schema: {
            tags: ['system'],
            summary: 'List admin-configured company shortcuts',
            description:
                'Returns the COMPANY_SHORTCUTS array set by the admin. Each entry has a ' +
                'title, target URL, and a mode of "link" (open in a new browser tab), ' +
                '"popup" (in-app floating iframe), or "embed" (full-pane embedded iframe).',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        shortcuts: { type: 'array', items: shortcutSchema }
                    }
                }
            }
        }
    }, async () => ({
        shortcuts: config.shortcuts.items
    }));
};
