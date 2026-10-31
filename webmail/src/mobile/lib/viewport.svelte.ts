/** Reactive viewport width for mobile layout breakpoints. */

import { MOBILE_TABLET_SPLIT_MIN_WIDTH_PX } from '../../lib/mobile-tablet-reading-pane';

function readWidth(): number {
    if (typeof window === 'undefined') return MOBILE_TABLET_SPLIT_MIN_WIDTH_PX;
    return window.innerWidth;
}

const viewport = $state({ width: readWidth() });

export function getMobileViewportWidth(): number {
    return viewport.width;
}

if (typeof window !== 'undefined') {
    const onResize = () => {
        viewport.width = window.innerWidth;
    };
    window.addEventListener('resize', onResize, { passive: true });
}
