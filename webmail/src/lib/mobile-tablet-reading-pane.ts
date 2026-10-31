/** Tablet-width split reading pane (Outlook mobile web parity). */

import type { ReadingPaneLayout } from './reading-pane-layout.ts';
import { isDockedReadingPane } from './reading-pane-layout.ts';

/** Minimum inner width to show list + reading pane together (iPad portrait). */
export const MOBILE_TABLET_SPLIT_MIN_WIDTH_PX = 768;

export function isTabletSplitViewport(viewportWidthPx: number): boolean {
    return viewportWidthPx >= MOBILE_TABLET_SPLIT_MIN_WIDTH_PX;
}

/** True when the mobile shell should dock the reading pane beside/under the list. */
export function shouldUseMobileTabletSplit(
    layout: ReadingPaneLayout,
    viewportWidthPx: number
): boolean {
    return isTabletSplitViewport(viewportWidthPx) && isDockedReadingPane(layout);
}

export type MobileTabletPaneAxis = 'horizontal' | 'vertical';

export function mobileTabletPaneAxis(layout: ReadingPaneLayout): MobileTabletPaneAxis {
    return layout === 'bottom' ? 'vertical' : 'horizontal';
}
