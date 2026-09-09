import Constants from '../../src/Constants.js';
import {expect} from 'chai';
import Utils from '../../src/Utils.js';
import MediaPlayerEvents from '../../../../src/streaming/MediaPlayerEvents.js';

import {
    checkIsPlaying,
    checkNoCriticalErrors,
    initializeDashJsAdapter
} from '../common/common.js';

const TESTCASE = Constants.TESTCASES.DODGE.TRAILING_COMPLETION;

// The fixture's data cycles cover the whole declared presentation: its embedded
// MPD is clipped to PT12.0S, which is exactly the three content segments, and
// eight trailing padding cycles follow them.
const CONTENT_CYCLES = 3;
const PADDING_CYCLES = 8;

// SegmentTemplate @duration 120 / @timescale 30.
const SEGMENT_DURATION_MS = 4000;

// Below one segment duration, so the mock buffer gates the padding from the
// first cycle instead of after filling the 18s default target.
const BUFFER_TARGET = 8;

// Init + content + padding, per media type, for one video representation and
// one audio representation.
const EXPECTED_REQUESTS = 2 * (1 + CONTENT_CYCLES + PADDING_CYCLES);
const COLLECTION_TIMEOUT = 90000;

// Same margins as the random walk measurement in defense-verification: allow a
// gap to come in at 60% of nominal for timer jitter and event loop overhead, and
// require 70% of the measured gaps to clear it rather than all of them.
const GAP_TOLERANCE = 0.6;
const GAP_PROPORTION = 0.7;

function trailingRequests(traffic, mediaType) {
    return traffic.filter((t) => t.mediaType === mediaType && t.trail === true);
}

// Response end to next request start, the same measurement defense-verification
// makes, so download time is excluded. Falls back to request timestamps when the
// HTTP timing is not populated.
function gapBefore(traffic, i) {
    const prev = traffic[i - 1].requestRef;
    const curr = traffic[i].requestRef;
    if (prev && prev.endDate && curr && curr.startDate) {
        return curr.startDate.getTime() - prev.endDate.getTime();
    }
    return traffic[i].timestamp - traffic[i - 1].timestamp;
}

Utils.getTestvectorsForTestcase(TESTCASE).forEach((item) => {
    const mpd = item.url;

    describe(`${TESTCASE} - ${item.name} - ${mpd}`, () => {
        let playerAdapter;
        let trafficPromise;
        let reachedTrailing = false;

        before(() => {
            playerAdapter = initializeDashJsAdapter(item, mpd, {
                streaming: {
                    abr: {
                        // Pin the representation so the cycle plan under test is
                        // the one the assertions below count against.
                        autoSwitchBitrate: { video: false, audio: false }
                    },
                    buffer: {
                        bufferTimeDefault: BUFFER_TARGET,
                        bufferTimeAtTopQuality: BUFFER_TARGET,
                        bufferTimeAtTopQualityLongForm: BUFFER_TARGET
                    }
                }
            });
            playerAdapter.registerEvent(MediaPlayerEvents.PLAYBACK_ENDED);
            trafficPromise = playerAdapter.collectDodgeTraffic(COLLECTION_TIMEOUT, EXPECTED_REQUESTS);
        })

        after(() => {
            if (playerAdapter) {
                playerAdapter.destroy();
            }
        })

        it(`Checking playing state`, async () => {
            await checkIsPlaying(playerAdapter, true);
        })

        it(`Dodge defense is active`, async () => {
            const timeout = Constants.TEST_TIMEOUT_THRESHOLDS.DODGE_PLAYING;
            const start = Date.now();
            let isActive = false;
            while (Date.now() - start < timeout) {
                isActive = playerAdapter.isDodgeActive();
                if (isActive) {
                    break;
                }
                await playerAdapter.sleep(200);
            }
            expect(isActive).to.be.true;
        })

        it(`Trailing phase is reached even though the period is fully buffered`, async () => {
            // The period buffers to its end as soon as the last content segment
            // is appended, and BufferController concludes buffering is complete
            // right there. ScheduleController refuses to arm a timer on a
            // completed buffer, so without the deferral the phase never starts.
            const timeout = 45000;
            const start = Date.now();
            while (Date.now() - start < timeout) {
                if (playerAdapter.isDodgeTrailing()) {
                    reachedTrailing = true;
                    break;
                }
                await playerAdapter.sleep(250);
            }
            expect(reachedTrailing, 'Expected isDodgeTrailing() to become true on a defense whose cycles cover the whole presentation').to.be.true;
        })

        it(`Every trailing padding cycle reaches the wire`, async () => {
            // A phase that never starts, or that stops early because the stream
            // was ended underneath it, fails here. Both media types are checked:
            // Stream only ends the source once every processor has finished, so
            // audio and video each have to run their padding to the end.
            const traffic = await trafficPromise;

            for (const mediaType of ['video', 'audio']) {
                const trailing = trailingRequests(traffic, mediaType);
                expect(trailing.length,
                    `Expected ${PADDING_CYCLES} trailing padding requests for ${mediaType}, saw ${trailing.length}`)
                    .to.be.at.least(PADDING_CYCLES);
            }
        })

        it(`Every trailing request is a padding cycle carrying the buffer directive`, async () => {
            // The spacing asserted below is only meaningful if each trailing
            // cycle actually credits the mock buffer. A trailing cycle without
            // the buffer directive contributes no simulated time, so the phase
            // would pace off whatever the previous cycles left instead.
            const traffic = await trafficPromise;

            for (const mediaType of ['video', 'audio']) {
                trailingRequests(traffic, mediaType).forEach((req, i) => {
                    expect(req.padding, `${mediaType} trailing cycle ${i}: expected a padding cycle`).to.be.true;
                    expect(req.buffer, `${mediaType} trailing cycle ${i}: expected the buffer directive`).to.be.true;
                });
            }
        })

        it(`Consecutive trailing cycles are spaced by the mock buffer, not by the schedule wait alone`, async () => {
            // Each buffered trailing cycle credits the mock buffer with one
            // segment's worth of time, and that credit drains in real time,
            // so the next cycle cannot go out until it has. The steady state
            // spacing is therefore the segment duration plus the random walk
            // delay the schedule controller adds on top, independent of the
            // buffer target.
            const traffic = await trafficPromise;
            const settings = playerAdapter.getSettings();
            const dodge = settings.dodge || {};
            const waitBase = dodge.scheduleWaitBase || 100;
            const waitRandom = dodge.scheduleWaitRandom || 50;

            const expectedGap = SEGMENT_DURATION_MS + waitBase;
            const minExpectedGap = expectedGap * GAP_TOLERANCE;
            // Upper bound catches the opposite failure, a phase that drags
            // because the mock buffer over-accumulates or drains too slowly.
            // Generous: the scheduler only re-evaluates on its own tick, so a
            // cycle can be held past its due time by a whole schedule timeout.
            const maxExpectedGap = (SEGMENT_DURATION_MS + waitBase + waitRandom) * 2;

            for (const mediaType of ['video', 'audio']) {
                const trailing = trailingRequests(traffic, mediaType);
                expect(trailing.length, `Expected trailing ${mediaType} requests to measure`).to.be.at.least(PADDING_CYCLES);

                let withinExpected = 0;
                const observed = [];
                for (let i = 1; i < trailing.length; i++) {
                    const gap = gapBefore(trailing, i);
                    observed.push(Math.round(gap));
                    if (gap >= minExpectedGap && gap <= maxExpectedGap) {
                        withinExpected++;
                    }
                }

                // The first gap is short: the mock buffer starts from whatever
                // the real buffer left behind, so the phase fills before it
                // paces. Allow for that the same way the random walk check
                // does, by requiring most gaps rather than all of them.
                const checked = trailing.length - 1;
                expect(withinExpected).to.be.at.least(Math.floor(checked * GAP_PROPORTION),
                    `${mediaType}: expected most trailing cycle gaps to fall within ` +
                    `[${Math.round(minExpectedGap)}, ${maxExpectedGap}]ms given a ${SEGMENT_DURATION_MS}ms segment ` +
                    `duration and scheduleWaitBase ${waitBase}ms, but only ${withinExpected}/${checked} did. Gaps: ${observed.join(', ')}`);
            }
        })

        it(`Playback finishes once the cycles are done`, async () => {
            // The mirror image of the deferral: holding buffering completion
            // back keeps the stream alive, and something has to hand it back or
            // the media source is never ended and the stream hangs on the last
            // padding cycle.
            const timeout = 45000;
            const start = Date.now();
            let ended = false;
            while (Date.now() - start < timeout) {
                ended = playerAdapter.hasEventBeenTriggered(MediaPlayerEvents.PLAYBACK_ENDED);
                if (ended) {
                    break;
                }
                await playerAdapter.sleep(250);
            }
            expect(ended, 'Expected PLAYBACK_ENDED after the trailing cycles finished; the deferred buffering completion was never released').to.be.true;
            expect(playerAdapter.isDodgeTrailing(), 'Expected the trailing phase to be over once playback ended').to.be.false;
        })

        it(`Expect no critical errors to be thrown`, () => {
            checkNoCriticalErrors(playerAdapter);
        })
    })
})
