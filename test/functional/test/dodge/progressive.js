import Constants from '../../src/Constants.js';
import {expect} from 'chai';
import Utils from '../../src/Utils.js';

import {
    checkIsPlaying,
    checkNoCriticalErrors,
    initializeDashJsAdapter
} from '../common/common.js';

const TESTCASE = Constants.TESTCASES.DODGE.PROGRESSIVE;

// The seed in bbb_30fps_progressive.exmfst.json is the first three cycles of
// bbb_30fps_undef.exmfst.json. Batches appended at runtime come from the rest of
// that same file.
const MEASURED_SOURCE = '/base/test/functional/content/dodge/bbb_30fps_undef.exmfst.json';
const SEED_CYCLES = 3;
const BATCH_SIZE = 4;

// How long to wait for the player to run out of seeded cycles and go quiet, and
// how long to keep the sustained generator running.
const STALL_SETTLE = 12000;
const RESUME_TIMEOUT = 20000;
const PUMP_DURATION = 10000;

/**
 * Cycles from the measured source for one label, starting past the seed.
 */
function measuredCycles(source, label) {
    const stream = source.streams.find(s => s.label === label);
    expect(stream, `No measured cycles for label ${label}`).to.not.be.undefined;
    return stream.data.slice(SEED_CYCLES);
}

/**
 * The highest segment index requested so far for a label, or -1.
 */
function highestIndex(traffic, label) {
    let highest = -1;
    for (const entry of traffic) {
        if (entry.representationId === label && entry.type === 'MediaSegment' && entry.index > highest) {
            highest = entry.index;
        }
    }
    return highest;
}

/**
 * Labels the player is actually fetching. ABR is pinned, but which video
 * representation it settles on is still the player's choice, and audio runs
 * alongside it, so the generator has to follow rather than assume.
 */
function activeLabels(traffic) {
    const labels = new Set();
    for (const entry of traffic) {
        if (entry.type === 'MediaSegment' && entry.representationId) {
            labels.add(entry.representationId);
        }
    }
    return Array.from(labels);
}

Utils.getTestvectorsForTestcase(TESTCASE).forEach((item) => {
    const mpd = item.url;

    describe(`${TESTCASE} - ${item.name} - ${mpd}`, () => {

        // A progressive defense is generated while it plays. The seed carries
        // three segments and nothing more, so the player runs out of cycles and
        // stalls until appendDodgeDataCycles supplies the next batch, and
        // finalizeDodgeStream is what finally ends generation.
        describe('generation lifecycle', () => {
            let playerAdapter;
            let source;
            let cursor = {};

            before(async () => {
                source = await (await fetch(MEASURED_SOURCE)).json();
                playerAdapter = initializeDashJsAdapter(item, mpd, {
                    streaming: {
                        abr: {
                            autoSwitchBitrate: { video: false, audio: false }
                        }
                    }
                });
                playerAdapter.startDodgeTrafficLog();
            })

            after(() => {
                if (playerAdapter) {
                    playerAdapter.stopDodgeTrafficLog();
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
                expect(isActive, 'Expected the progressive seed to activate a defense').to.be.true;
            })

            it(`Cycle requests stop at the end of the seeded cycles`, async () => {
                // The override stalls rather than finishing when it runs off the
                // end of a progressive stream, so requests go quiet and stay
                // quiet.
                let previous = -1;
                let settled = 0;
                const start = Date.now();
                while (Date.now() - start < STALL_SETTLE) {
                    const count = playerAdapter.getDodgeTrafficLog().length;
                    settled = (count === previous) ? settled + 1 : 0;
                    if (settled >= 3) {
                        break;
                    }
                    previous = count;
                    await playerAdapter.sleep(500);
                }

                const traffic = playerAdapter.getDodgeTrafficLog();
                const labels = activeLabels(traffic);
                expect(labels.length, 'Expected at least one representation to be fetching').to.be.at.least(1);

                for (const label of labels) {
                    expect(highestIndex(traffic, label),
                        `${label} fetched past the seeded cycles while the stream was still progressive`)
                        .to.equal(SEED_CYCLES - 1);
                    cursor[label] = 0;
                }
            })

            it(`An appended batch resumes cycle requests`, async () => {
                const traffic = playerAdapter.getDodgeTrafficLog();
                const labels = activeLabels(traffic);

                for (const label of labels) {
                    const cycles = measuredCycles(source, label).slice(0, BATCH_SIZE);
                    expect(playerAdapter.appendDodgeDataCycles(label, null, cycles),
                        `appendDodgeDataCycles was rejected for ${label}`).to.be.true;
                    cursor[label] = BATCH_SIZE;
                }

                const target = SEED_CYCLES - 1 + BATCH_SIZE;
                const start = Date.now();
                let reached = false;
                while (Date.now() - start < RESUME_TIMEOUT) {
                    const now = playerAdapter.getDodgeTrafficLog();
                    reached = labels.every(label => highestIndex(now, label) >= target);
                    if (reached) {
                        break;
                    }
                    await playerAdapter.sleep(500);
                }

                expect(reached, 'Expected the appended batch to be requested once it was available').to.be.true;
            })

            it(`A batch ending in padding does not enter the trailing phase`, async () => {
                // The shape a progressive generator naturally produces: fetch the
                // content cycles, then a padding cycle that also carries the
                // flush. maxNoPad then points before the end of the data, which
                // must not be read as the end of the content while the stream is
                // still being generated.
                const traffic = playerAdapter.getDodgeTrafficLog();
                const labels = activeLabels(traffic);

                for (const label of labels) {
                    const available = measuredCycles(source, label);
                    const content = available.slice(cursor[label], cursor[label] + 2)
                        .map(cycle => ({ index: cycle.index, range: cycle.range }));
                    const padding = available[cursor[label]];

                    const batch = content.concat([{
                        index: padding.index,
                        range: padding.range,
                        padding: true,
                        buffer: true
                    }]);

                    expect(playerAdapter.appendDodgeDataCycles(label, null, batch),
                        `A batch ending in padding was rejected for ${label}`).to.be.true;
                    cursor[label] += 2;
                }

                // Give the player time to work through the batch, including its
                // final padding cycle, and confirm it never reports trailing.
                const start = Date.now();
                let reportedTrailing = false;
                while (Date.now() - start < RESUME_TIMEOUT) {
                    if (playerAdapter.isDodgeTrailing()) {
                        reportedTrailing = true;
                        break;
                    }
                    await playerAdapter.sleep(250);
                }

                expect(reportedTrailing,
                    'A batch ending in padding was reported as the trailing phase while the stream was still progressive')
                    .to.be.false;
            })

            it(`Padding cycles in a mid-generation batch are not marked trail`, async () => {
                // Waits for the padding cycle itself rather than reading whatever
                // the previous test happened to leave behind, so a failure here
                // reports the flag that is wrong rather than a race.
                const start = Date.now();
                let padding = [];
                while (Date.now() - start < RESUME_TIMEOUT) {
                    padding = playerAdapter.getDodgeTrafficLog().filter(entry => entry.padding === true);
                    if (padding.length > 0) {
                        break;
                    }
                    await playerAdapter.sleep(250);
                }

                expect(padding.length, 'The appended padding cycles were never requested').to.be.at.least(1);
                for (const entry of padding) {
                    expect(entry.trail,
                        `Padding cycle for segment ${entry.index} of ${entry.representationId} was marked trail before finalizeStream`)
                        .to.not.be.true;
                }
            })

            it(`finalizeDodgeStream ends generation and reaches the trailing phase`, async () => {
                const traffic = playerAdapter.getDodgeTrafficLog();
                const labels = activeLabels(traffic);

                for (const label of labels) {
                    const available = measuredCycles(source, label);
                    const trailing = available.slice(cursor[label], cursor[label] + 3)
                        .map(cycle => ({ index: cycle.index, range: cycle.range, padding: true }));

                    expect(playerAdapter.finalizeDodgeStream(label, null, trailing),
                        `finalizeDodgeStream was rejected for ${label}`).to.be.true;
                }

                const start = Date.now();
                let isTrailing = false;
                while (Date.now() - start < RESUME_TIMEOUT) {
                    isTrailing = playerAdapter.isDodgeTrailing();
                    if (isTrailing) {
                        break;
                    }
                    await playerAdapter.sleep(250);
                }

                expect(isTrailing, 'Expected the trailing phase once the stream was finalized').to.be.true;
            })

            // Appending after finalizeStream is refused, and the refusal is
            // logged as an error. That belongs in the unit tests (R9.14) rather
            // than here, where provoking it would empty out the only assertion
            // that a genuine error went unnoticed.

            it(`Expect no critical errors to be thrown`, () => {
                checkNoCriticalErrors(playerAdapter);
            })
        })

        // Repeated appends ahead of the playhead, the way a real generator runs.
        describe('sustained generation', () => {
            let playerAdapter;
            let source;

            before(async () => {
                source = await (await fetch(MEASURED_SOURCE)).json();
                playerAdapter = initializeDashJsAdapter(item, mpd, {
                    streaming: {
                        abr: {
                            autoSwitchBitrate: { video: false, audio: false }
                        }
                    }
                });
                playerAdapter.startDodgeTrafficLog();
            })

            after(() => {
                if (playerAdapter) {
                    playerAdapter.stopDodgeTrafficLog();
                    playerAdapter.destroy();
                }
            })

            it(`Checking playing state`, async () => {
                await checkIsPlaying(playerAdapter, true);
            })

            it(`Playback advances while cycles are generated ahead of the playhead`, async () => {
                const cursor = {};
                const startTime = playerAdapter.getCurrentTime();
                const start = Date.now();

                while (Date.now() - start < PUMP_DURATION) {
                    const traffic = playerAdapter.getDodgeTrafficLog();
                    for (const label of activeLabels(traffic)) {
                        if (cursor[label] === undefined) {
                            cursor[label] = 0;
                        }
                        const available = measuredCycles(source, label);
                        // Top up whenever the player has caught up to within one
                        // batch of the cycles generated so far.
                        const generated = SEED_CYCLES - 1 + cursor[label];
                        if (highestIndex(traffic, label) >= generated - 1 && cursor[label] < available.length) {
                            const batch = available.slice(cursor[label], cursor[label] + BATCH_SIZE);
                            if (batch.length > 0) {
                                expect(playerAdapter.appendDodgeDataCycles(label, null, batch),
                                    `A generated batch was rejected for ${label}`).to.be.true;
                                cursor[label] += batch.length;
                            }
                        }
                    }
                    await playerAdapter.sleep(250);
                }

                const appended = Object.keys(cursor).filter(label => cursor[label] > 0);
                expect(appended.length, 'Expected the generator to have appended at least one batch').to.be.at.least(1);
                expect(playerAdapter.getCurrentTime(),
                    'Expected playback to advance while cycles were generated ahead of it')
                    .to.be.above(startTime);
            })

            it(`Expect no critical errors to be thrown`, () => {
                checkNoCriticalErrors(playerAdapter);
            })
        })
    })
})
