import Constants from '../../src/Constants.js';
import { expect } from 'chai';

// How long a defense is given to become active or to reach the trailing phase.
// Activation needs the manifest load plus the first cycle request; trailing
// needs every content cycle to have been downloaded and played out first, so it
// gets a much longer window.
const ACTIVE_TIMEOUT = Constants.TEST_TIMEOUT_THRESHOLDS.DODGE_PLAYING;
const TRAILING_TIMEOUT = 45000;

const POLL_INTERVAL = 250;

/**
 * Settings for a defended playback test.
 *
 * Every one of these pins the representation. The cycle plan under test is the
 * one the extended manifest declares for a single representation, and an ABR
 * switch part way through replaces it with a different representation's plan,
 * which makes any cycle-by-cycle comparison meaningless. Tests that exist to
 * exercise switching ask for it explicitly instead.
 *
 * @param {Object} [overrides] - `dodge` is passed through as is; `streaming` is
 *        merged alongside the pinned `abr` block.
 * @returns {Object} Settings object for `initializeDashJsAdapter`.
 */
export function defendedSettings(overrides = {}) {
    const settings = {
        streaming: {
            abr: {
                autoSwitchBitrate: { video: false, audio: false }
            },
            ...(overrides.streaming || {})
        }
    };
    if (overrides.dodge) {
        settings.dodge = overrides.dodge;
    }
    return settings;
}

async function _pollUntil(playerAdapter, predicate, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (predicate()) {
            return true;
        }
        await playerAdapter.sleep(POLL_INTERVAL);
    }
    return predicate();
}

export function waitForDodgeActive(playerAdapter, timeout = ACTIVE_TIMEOUT) {
    return _pollUntil(playerAdapter, () => playerAdapter.isDodgeActive(), timeout);
}

export async function checkDodgeActive(playerAdapter, timeout = ACTIVE_TIMEOUT) {
    const isActive = await waitForDodgeActive(playerAdapter, timeout);
    expect(isActive, 'Expected isDodgeActive() to become true').to.be.true;
}

export function checkDodgeNotActive(playerAdapter) {
    expect(playerAdapter.isDodgeActive(), 'Expected isDodgeActive() to be false').to.be.false;
}

export function waitForDodgeTrailing(playerAdapter, timeout = TRAILING_TIMEOUT) {
    return _pollUntil(playerAdapter, () => playerAdapter.isDodgeTrailing(), timeout);
}

export async function checkDodgeTrailing(playerAdapter, timeout = TRAILING_TIMEOUT) {
    const isTrailing = await waitForDodgeTrailing(playerAdapter, timeout);
    expect(isTrailing, 'Expected isDodgeTrailing() to become true').to.be.true;
}

/**
 * Sample the reported buffer level across a window and require every numeric
 * sample to be non-negative.
 *
 * `getBufferLength` reports NaN for an empty buffer, which the trailing phase
 * reaches by design once the playable content has drained, so a NaN sample is
 * tolerated rather than failed. The single-sample checks this replaces read the
 * level once and skipped their assertion on NaN, which meant they ran no
 * assertion at all in the state they existed to police. Sampling across a
 * window keeps the NaN tolerance and still puts the assertion in front of the
 * levels the mock buffer actually reports.
 *
 * Pair it with `checkBufferBecomesPositive` on the same vector. That one fails
 * if the level is never observable, so the two together cannot both pass
 * vacuously.
 *
 * @returns {number} How many numeric samples were seen.
 */
export async function checkBufferNeverNegative(playerAdapter, mediaType, durationMs) {
    const start = Date.now();
    let samples = 0;

    while (Date.now() - start < durationMs) {
        const level = playerAdapter.getBufferLengthByType(mediaType);
        if (typeof level === 'number' && !isNaN(level)) {
            expect(level).to.be.at.least(0,
                `Reported ${mediaType} buffer level went negative, the mock buffer is not clamping`);
            samples++;
        }
        await playerAdapter.sleep(POLL_INTERVAL);
    }

    return samples;
}

/**
 * Require the reported buffer level to be observed above zero at least once,
 * and to never be negative on the way there.
 *
 * @param {Function} [stopWhen] - Optional predicate that ends the window early.
 */
export async function checkBufferBecomesPositive(playerAdapter, mediaType, timeoutMs, stopWhen = null) {
    const start = Date.now();
    let wasPositive = false;

    while (Date.now() - start < timeoutMs) {
        const level = playerAdapter.getBufferLengthByType(mediaType);
        if (typeof level === 'number' && !isNaN(level)) {
            expect(level).to.be.at.least(0,
                `Reported ${mediaType} buffer level went negative, the mock buffer is not clamping`);
            if (level > 0) {
                wasPositive = true;
            }
        }
        if (wasPositive || (stopWhen && stopWhen())) {
            break;
        }
        await playerAdapter.sleep(POLL_INTERVAL);
    }

    expect(wasPositive,
        `Expected the reported ${mediaType} buffer level to be positive at some point`).to.be.true;
}

export async function fetchExtendedManifest(url) {
    const response = await fetch(url);
    return response.json();
}

/**
 * Streams the extended manifest declares for one media type, identified by
 * which of the MPD's representations the label matches. Audio and video labels
 * live in one list, so callers that need a specific stream look it up by label.
 */
export function findStream(manifest, label, periodIndex = null) {
    return manifest.streams.find((stream) => stream.label === label &&
        (periodIndex === null || (stream.period || 0) === periodIndex));
}

/**
 * Number of padding cycles in the run that closes out a stream's data cycles.
 *
 * This is what the trailing phase downloads after the last playable segment, so
 * a test can count what reached the wire against what the manifest declares
 * rather than against a constant copied out of the fixture.
 */
export function trailingPaddingCount(stream) {
    let count = 0;
    for (let i = stream.data.length - 1; i >= 0; i--) {
        if (!stream.data[i].padding) {
            break;
        }
        count++;
    }
    return count;
}

/**
 * The smallest trailing padding run across every stream in the manifest. A
 * defense runs its padding per media type, so an assertion that has to hold for
 * both video and audio is written against the shorter of the two.
 */
export function minTrailingPaddingCount(manifest) {
    return manifest.streams.reduce(
        (min, stream) => Math.min(min, trailingPaddingCount(stream)), Infinity);
}

export function trailingRequests(traffic, mediaType) {
    return traffic.filter((entry) => entry.mediaType === mediaType && entry.trail === true);
}

/**
 * Response end to next request start, so download time is excluded from the
 * measured gap. Falls back to request timestamps when the HTTP timing is not
 * populated.
 */
export function gapBefore(traffic, i) {
    const prev = traffic[i - 1].requestRef;
    const curr = traffic[i].requestRef;
    if (prev && prev.endDate && curr && curr.startDate) {
        return curr.startDate.getTime() - prev.endDate.getTime();
    }
    return traffic[i].timestamp - traffic[i - 1].timestamp;
}
