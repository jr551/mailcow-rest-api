import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    MOBILE_TABLET_SPLIT_MIN_WIDTH_PX,
    isTabletSplitViewport,
    shouldUseMobileTabletSplit,
    mobileTabletPaneAxis
} from '../../src/lib/mobile-tablet-reading-pane.ts';

describe('mobile-tablet-reading-pane', () => {
    it('uses 768px as the tablet split breakpoint', () => {
        assert.equal(MOBILE_TABLET_SPLIT_MIN_WIDTH_PX, 768);
        assert.equal(isTabletSplitViewport(767), false);
        assert.equal(isTabletSplitViewport(768), true);
    });

    it('respects reading pane layout for split mode', () => {
        assert.equal(shouldUseMobileTabletSplit('right', 900), true);
        assert.equal(shouldUseMobileTabletSplit('bottom', 900), true);
        assert.equal(shouldUseMobileTabletSplit('hidden', 900), false);
        assert.equal(shouldUseMobileTabletSplit('right', 390), false);
    });

    it('maps bottom layout to vertical pane axis', () => {
        assert.equal(mobileTabletPaneAxis('right'), 'horizontal');
        assert.equal(mobileTabletPaneAxis('bottom'), 'vertical');
        assert.equal(mobileTabletPaneAxis('hidden'), 'horizontal');
    });
});
