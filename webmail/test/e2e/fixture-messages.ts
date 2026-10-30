export const MOCK_USER = 'demo@test.local';
export const MOCK_PASS = 'hunter2';

export type FixtureListMessage = {
    uid: number;
    seq: number;
    flags: string[];
    size: number;
    internalDate: string;
    hasAttachments?: boolean;
    envelope: {
        date: string;
        subject: string;
        from: { name: string | null; address: string }[];
        to: { name: string | null; address: string }[];
        cc: { name: string | null; address: string }[];
        messageId: string;
        inReplyTo: string | null;
    };
};

/** Realistic fictional INBOX list for Playwright mocks (~18 messages). */
export const fixtureMessages: FixtureListMessage[] = [
    {
        uid: 1001, seq: 1, flags: [], size: 1234,
        internalDate: '2026-04-29T10:32:00Z',
        envelope: {
            date: '2026-04-29T10:32:00Z',
            subject: 'Welcome to your new webmail',
            from: [{ name: 'Concierge', address: 'concierge@example.com' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [], messageId: '<welcome@imap-rest>', inReplyTo: null
        }
    },
    {
        uid: 1018, seq: 2, flags: [], size: 890,
        internalDate: '2026-04-29T09:15:00Z',
        envelope: {
            date: '2026-04-29T09:15:00Z',
            subject: 'Stand-up notes for Thursday',
            from: [{ name: 'Alex Chen', address: 'alex.chen@northwind.example' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [], messageId: '<standup-4@northwind>', inReplyTo: null
        }
    },
    {
        uid: 1017, seq: 3, flags: ['\\Seen'], size: 2100,
        internalDate: '2026-04-29T08:40:00Z',
        hasAttachments: true,
        envelope: {
            date: '2026-04-29T08:40:00Z',
            subject: 'Wireframe feedback — v3',
            from: [{ name: 'Jordan Lee', address: 'jordan.lee@studio.example' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [], messageId: '<wire-v3@studio>', inReplyTo: null
        }
    },
    {
        uid: 1016, seq: 4, flags: ['\\Seen', '\\Flagged'], size: 640,
        internalDate: '2026-04-28T19:22:00Z',
        envelope: {
            date: '2026-04-28T19:22:00Z',
            subject: 'Contract redlines for Project Atlas',
            from: [{ name: 'Morgan Blake', address: 'morgan.blake@legal.example' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [], messageId: '<atlas-redlines@legal>', inReplyTo: null
        }
    },
    {
        uid: 1015, seq: 5, flags: ['\\Seen'], size: 420,
        internalDate: '2026-04-28T17:05:00Z',
        envelope: {
            date: '2026-04-28T17:05:00Z',
            subject: 'Re: Budget approval for Q3',
            from: [{ name: 'Taylor Brooks', address: 'taylor.brooks@finance.example' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [], messageId: '<budget-q3@finance>', inReplyTo: '<budget-q3-seed@finance>'
        }
    },
    {
        uid: 1014, seq: 6, flags: [], size: 380,
        internalDate: '2026-04-28T15:30:00Z',
        envelope: {
            date: '2026-04-28T15:30:00Z',
            subject: 'Can you review the deck before noon?',
            from: [{ name: 'Riley Park', address: 'riley.park@northwind.example' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [], messageId: '<deck-review@northwind>', inReplyTo: null
        }
    },
    {
        uid: 1000, seq: 7, flags: ['\\Seen'], size: 4321,
        hasAttachments: true,
        internalDate: '2026-04-28T16:09:00Z',
        envelope: {
            date: '2026-04-28T16:09:00Z',
            subject: 'Q2 invoice ready for review',
            from: [{ name: 'Acme Billing', address: 'billing@acme.example' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [], messageId: '<inv-1@acme>', inReplyTo: null
        }
    },
    {
        uid: 1013, seq: 8, flags: ['\\Seen'], size: 520,
        internalDate: '2026-04-28T14:11:00Z',
        envelope: {
            date: '2026-04-28T14:11:00Z',
            subject: 'Weekly digest — product updates',
            from: [{ name: 'Product Updates', address: 'newsletter@updates.example' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [], messageId: '<digest-w18@updates>', inReplyTo: null
        }
    },
    {
        uid: 1012, seq: 9, flags: ['\\Seen'], size: 290,
        internalDate: '2026-04-28T11:00:00Z',
        envelope: {
            date: '2026-04-28T11:00:00Z',
            subject: 'Your order #48291 has shipped',
            from: [{ name: 'Orders', address: 'orders@shop.example' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [], messageId: '<order-48291@shop>', inReplyTo: null
        }
    },
    {
        uid: 999, seq: 10, flags: ['\\Seen', '\\Flagged'], size: 200,
        internalDate: '2026-04-27T08:00:00Z',
        envelope: {
            date: '2026-04-27T08:00:00Z',
            subject: 'Re: lunch on Friday?',
            from: [{ name: 'Sam', address: 'sam@friend.example' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [], messageId: '<lunch-2@friend>', inReplyTo: '<lunch-1@friend>'
        }
    },
    {
        uid: 997, seq: 11, flags: ['\\Seen'], size: 180,
        internalDate: '2026-04-26T12:00:00Z',
        envelope: {
            date: '2026-04-26T12:00:00Z',
            subject: 'lunch on Friday?',
            from: [{ name: 'Sam', address: 'sam@friend.example' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [], messageId: '<lunch-1@friend>', inReplyTo: null
        }
    },
    {
        uid: 1011, seq: 12, flags: [], size: 310,
        internalDate: '2026-04-27T16:45:00Z',
        envelope: {
            date: '2026-04-27T16:45:00Z',
            subject: 'Parking pass renewal',
            from: [{ name: 'Facilities', address: 'facilities@campus.example' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [], messageId: '<parking@campus>', inReplyTo: null
        }
    },
    {
        uid: 1010, seq: 13, flags: ['\\Seen'], size: 450,
        internalDate: '2026-04-27T10:20:00Z',
        envelope: {
            date: '2026-04-27T10:20:00Z',
            subject: 'Interview panel — backend role',
            from: [{ name: 'People Ops', address: 'recruiting@talent.example' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [], messageId: '<interview@talent>', inReplyTo: null
        }
    },
    {
        uid: 1009, seq: 14, flags: ['\\Seen'], size: 275,
        internalDate: '2026-04-26T18:00:00Z',
        envelope: {
            date: '2026-04-26T18:00:00Z',
            subject: 'Flash sale — 24 hours only',
            from: [{ name: 'Deals', address: 'deals@promo.example' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [], messageId: '<flash@promo>', inReplyTo: null
        }
    },
    {
        uid: 998, seq: 15, flags: ['\\Seen'], size: 800,
        internalDate: '2026-04-26T14:22:00Z',
        envelope: {
            date: '2026-04-26T14:22:00Z',
            subject: 'Opened: Your proposal was viewed',
            from: [{ name: 'Read receipts', address: 'read-receipts@studio.example' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [], messageId: '<track-1@example>', inReplyTo: null
        }
    },
    {
        uid: 1008, seq: 16, flags: ['\\Seen'], size: 360,
        internalDate: '2026-04-26T09:30:00Z',
        envelope: {
            date: '2026-04-26T09:30:00Z',
            subject: 'Security alert: new sign-in',
            from: [{ name: 'Security', address: 'security@accounts.example' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [], messageId: '<sec-signin@accounts>', inReplyTo: null
        }
    },
    {
        uid: 1007, seq: 17, flags: [], size: 190,
        internalDate: '2026-04-25T20:10:00Z',
        envelope: {
            date: '2026-04-25T20:10:00Z',
            subject: 'Notes from yesterday\'s workshop',
            from: [{ name: 'Casey Nguyen', address: 'casey.nguyen@northwind.example' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [], messageId: '<workshop@northwind>', inReplyTo: null
        }
    },
    {
        uid: 1002, seq: 18, flags: [], size: 2000,
        internalDate: '2026-04-25T11:00:00Z',
        envelope: {
            date: '2026-04-25T11:00:00Z',
            subject: 'Fwd: Special offer inside',
            from: [{ name: 'Promo Desk', address: 'promo@retailer.example' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [], messageId: '<promo-fwd@retailer>', inReplyTo: null
        }
    },
    {
        uid: 1020, seq: 19, flags: ['\\Seen'], size: 310,
        internalDate: '2026-04-28T12:00:00Z',
        envelope: {
            date: '2026-04-28T12:00:00Z',
            subject: 'FYI — loop you in on the thread',
            from: [{ name: 'Pat Kim', address: 'pat.kim@northwind.example' }],
            to: [{ name: null, address: 'alex.chen@northwind.example' }],
            cc: [{ name: null, address: MOCK_USER }],
            messageId: '<cc-loop@northwind>', inReplyTo: null
        }
    },
    {
        uid: 1021, seq: 20, flags: [], size: 280,
        internalDate: '2026-04-28T11:45:00Z',
        envelope: {
            date: '2026-04-28T11:45:00Z',
            subject: '@demo please sign off on the mockups',
            from: [{ name: 'Jordan Lee', address: 'jordan.lee@studio.example' }],
            to: [{ name: null, address: MOCK_USER }],
            cc: [], messageId: '<mention-demo@studio>', inReplyTo: null
        }
    }
];
