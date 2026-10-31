import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    MOBILE_COMPOSE_ACTIONS_LABEL,
    MOBILE_COMPOSE_FIELDS_LABEL,
    MOBILE_COMPOSE_LABEL,
    MOBILE_COMPOSE_LANDMARK_ID,
    MOBILE_COMPOSE_LANDMARK_ROWS
} from '../../src/lib/mobile-compose-landmarks.ts';

describe('mobile-compose-landmarks (slice 38)', () => {
    it('uses a stable compose landmark id', () => {
        assert.equal(MOBILE_COMPOSE_LANDMARK_ID, 'mail-compose-landmark');
    });

    it('documents compose sub-regions in reading order', () => {
        const regions = MOBILE_COMPOSE_LANDMARK_ROWS.map((r) => r.region);
        assert.deepEqual(regions, [
            MOBILE_COMPOSE_LABEL,
            MOBILE_COMPOSE_FIELDS_LABEL,
            MOBILE_COMPOSE_ACTIONS_LABEL
        ]);
    });
});
