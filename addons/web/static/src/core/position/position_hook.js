/** @odoo-module */

import { useEffect } from "@web/core/utils/hooks";
import { debounce, throttle } from "../utils/timing";

/**
 * @typedef {{
 *  popper?: string;
 *  container?: HTMLElement;
 *  margin?: number;
 *  position?: Position;
 *  directionFlipOrder?: DirectionFlipOrder;
 *  variantFlipOrder?: VariantFlipOrder;
 * }} Options
 *
 * @typedef {{
 *  directions: (DirectionsDataKey)[];
 *  variants: (VariantsDataKey)[];
 *  get: (d?: DirectionsDataKey, v?: VariantsDataKey, containerRestricted?: boolean) => PositioningSolution | null;
 * }} Positioning
 *
 * @typedef {keyof DirectionsData} DirectionsDataKey
 * @typedef {{
 *  t: number;
 *  b: number;
 *  l: number;
 *  r: number;
 * }} DirectionsData
 *
 * @typedef {keyof VariantsData} VariantsDataKey
 * @typedef {{
 *  vs: number;
 *  vm: number;
 *  ve: number;
 *  hs: number;
 *  hm: number;
 *  he: number;
 * }} VariantsData
 *
 * @typedef {"top" | "left" | "bottom" | "right"} Direction
 * @typedef {"start" | "middle" | "end"} Variant
 *
 * @typedef {{[direction in Direction]: string}} DirectionFlipOrder
 *  values are successive DirectionsDataKey represented as a single string
 *
 * @typedef {{[variant in Variant]: string}} VariantFlipOrder
 *  values are successive VariantsDataKey represented as a single string
 *
 * @typedef {Direction
 *  | "top-start" | "top-middle" | "top-end"
 *  | "left-start" | "left-middle" | "left-end"
 *  | "right-start" | "right-middle" | "right-end"
 *  | "bottom-start" | "bottom-middle" | "bottom-end"} Position
 *
 * @typedef {{ className: string, top: number, left: number }} PositioningSolution
 */

const { hooks } = owl;
const { useComponent, useExternalListener, useRef } = hooks;

const POPPER_CLASS = "o-popper-position";

/** @type {Options} */
export const DEFAULTS = {
    margin: 0,
    position: "bottom",
    directionFlipOrder: { top: "tbrl", right: "rltb", bottom: "btrl", left: "lrbt" },
    variantFlipOrder: { start: "sme", middle: "mse", end: "ems" },
};

/**
 * Computes positioning data used to determine each possible position
 * based on the reference, popper, and container sizes.
 * Particularly, a popper must not overflow the container in any direction,
 * it should actually stay at `margin` distance from the border to look good.
 *
 * @param {HTMLElement} reference
 * @param {HTMLElement} popper
 * @param {Options} options
 * @returns {Positioning} a positioning object containing:
 *  - ascendingly sorted directions and variants
 *  - a method returning style to apply to the popper for a given direction and variant
 */
export function computePositioning(reference, popper, options) {
    const { container, margin, position, directionFlipOrder, variantFlipOrder } = options;

    // Retrieve directions and variants
    const [directionKey, variantKey = "middle"] = position.split("-");
    const directions = directionFlipOrder[directionKey];
    const variants = variantFlipOrder[variantKey];

    // Boxes
    const popBox = popper.getBoundingClientRect();
    const refBox = reference.getBoundingClientRect();
    const contBox = container.getBoundingClientRect();

    // Compute positioning data
    /** @type {DirectionsData} */
    const directionsData = {
        t: refBox.top - popBox.height - margin,
        b: refBox.bottom + margin,
        r: refBox.right + margin,
        l: refBox.left - popBox.width - margin,
    };
    /** @type {VariantsData} */
    const variantsData = {
        vs: refBox.left,
        vm: refBox.left + refBox.width / 2 + -popBox.width / 2,
        ve: refBox.right - popBox.width,
        hs: refBox.top,
        hm: refBox.top + refBox.height / 2 + -popBox.height / 2,
        he: refBox.bottom - popBox.height,
    };

    function get(d = directions[0], v = variants[0], containerRestricted = false) {
        const vertical = ["t", "b"].includes(d);
        const variantPrefix = vertical ? "v" : "h";
        const directionValue = directionsData[d];
        const variantValue = variantsData[variantPrefix + v];

        if (containerRestricted) {
            const [directionSize, variantSize] = vertical
                ? [popBox.height + margin, popBox.width]
                : [popBox.width, popBox.height + margin];
            const [directionMin, directionMax] = vertical
                ? [contBox.top, contBox.bottom]
                : [contBox.left, contBox.right];
            const [variantMin, variantMax] = vertical
                ? [contBox.left, contBox.right]
                : [contBox.top, contBox.bottom];

            // Abort if outside container boundaries
            const directionOverflow =
                directionValue < directionMin || directionValue + directionSize > directionMax;
            const variantOverflow =
                variantValue < variantMin || variantValue + variantSize > variantMax;
            if (directionOverflow || variantOverflow) {
                return null;
            }
        }

        const positioning = vertical
            ? {
                  top: directionValue,
                  left: variantValue,
              }
            : {
                  top: variantValue,
                  left: directionValue,
              };
        return { ...positioning, className: `${POPPER_CLASS}--${d}${v}` };
    }

    return {
        directions,
        variants,
        get,
    };
}

/**
 * This method will try to position the popper as requested (according to options).
 * If the requested position does not fit the container, other positions will be
 * tried in different direction and variant flip orders (depending on the requested position).
 * If no position is found that fits the container, the requested position stays used.
 *
 * When the final position is applied, a corresponding CSS class is also added to the popper.
 * This could be used to further styling.
 *
 * @param {HTMLElement} reference
 * @param {HTMLElement} popper
 * @param {Options} options
 */
function reposition(reference, popper, options) {
    options = {
        container: document.documentElement,
        ...DEFAULTS,
        ...options,
    };

    // Reset all existing popper classes and only leave it as standalone
    for (const popperClass of popper.classList) {
        if (popperClass.startsWith(POPPER_CLASS)) {
            popper.classList.remove(popperClass);
        }
    }
    popper.classList.add(POPPER_CLASS);

    // Compute positioning and find first match
    const positioning = computePositioning(reference, popper, options);
    for (const d of positioning.directions) {
        for (const v of positioning.variants) {
            const posData = positioning.get(d, v, true);
            if (!posData) {
                continue;
            }

            // From now, a position match have been found.
            // Apply styles
            const { className, top, left } = posData;
            popper.classList.add(className);
            popper.style.top = `${top}px`;
            popper.style.left = `${left}px`;
            return;
        }
    }

    // use the given `position` because no position fits
    const { className, top, left } = positioning.get();
    popper.classList.add(className);
    popper.style.top = `${top}px`;
    popper.style.left = `${left}px`;
}

/**
 * Makes sure that the `popper` element is always
 * placed at `position` from the `reference` element.
 * If doing so the `popper` element is clipped off `container`,
 * sensible fallback positions are tried.
 * If all of fallback positions are also clipped off `container`,
 * the original position is used.
 *
 * @param {HTMLElement | (()=>HTMLElement)} reference
 * @param {Options} options
 */
export function usePosition(reference, options) {
    options = { ...DEFAULTS, ...options };
    const { popper } = options;
    const popperRef = popper ? useRef(popper) : useComponent();
    const getReference = reference instanceof HTMLElement ? () => reference : reference;
    const update = () => {
        if (popperRef.el) {
            reposition(getReference(), popperRef.el, options);
        }
    };
    useEffect(update);
    useExternalListener(document, "scroll", throttle(update, 50), { capture: true });
    useExternalListener(window, "resize", debounce(update, 250));
}
