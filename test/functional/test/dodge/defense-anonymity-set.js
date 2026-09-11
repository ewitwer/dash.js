import Constants from '../../src/Constants.js';
import { expect } from 'chai';
import Utils from '../../src/Utils.js';

import {
    checkNoCriticalErrors,
    initializeDashJsAdapterWithoutAttachSource,
    playForDuration
} from '../common/common.js';

import {
    checkDodgeActive,
    defendedSettings
} from '../common/dodge.js';

const TESTCASE = Constants.TESTCASES.DODGE.DEFENSE_ANONYMITY_SET;

// A very important deliverable: two unrelated videos, defended to one
// plan, are indistinguishable to someone who can see only the traffic.
// Every other test in this suite checks a defense against its own manifest,
// which is self-consistency. This one checks two defenses against each other.

// Long enough for the plan to go out, short enough that the session is still
// playing when it ends.
const OBSERVE_MS = 25000;

// The set is defined over the leading cycles of the plan. Later ones are still
// generated identically, but a fixed prefix keeps the comparison independent of
// how far each session happened to get before the window closed.
const COMPARE_PREFIX = 12;

// Sequences recorded per source, compared once both have run. Module scope on
// purpose: each vector is its own player session, and the property under test
// only exists between them.
const observed = {};

/**
 * Every sized segment response the source put on the wire, in order, split by
 * media type.
 *
 * Init segments count. An observer watching a representation sees its init
 * segment before anything else, so a set whose members answer the opening
 * request with different sizes is separable on that request alone, no matter
 * how well the media cycles line up afterwards. Each entry carries its request
 * type so a mismatch says which kind of request diverged.
 */
function responseSequenceByType(log) {
    const byType = {};
    log.forEach((entry) => {
        if (!entry.mediaType || isNaN(entry.responseBytes) || entry.responseBytes <= 0 ||
                (entry.requestType !== 'MediaSegment' &&
                    entry.requestType !== 'InitializationSegment')) {
            return;
        }
        (byType[entry.mediaType] = byType[entry.mediaType] || []).push({
            type: entry.requestType,
            bytes: entry.responseBytes
        });
    });
    return byType;
}

/**
 * The sequence up to and including its `count`-th media segment, with whatever
 * init requests fell inside that stretch left where they were.
 *
 * Cutting on media segments rather than on a raw entry count keeps the reason
 * for a fixed prefix intact while still pinning how init interleaves with
 * media. An init segment refetched mid-stream on one source and not the other
 * lands inside the window as an extra entry.
 *
 * @param {Array} sequence - Entries from responseSequenceByType, in order.
 * @param {number} count - How many media segments the window has to cover.
 * @returns {Array|null} The prefix, or null if that many never arrived.
 */
function prefixThroughMediaSegment(sequence, count) {
    let seen = 0;
    for (let i = 0; i < sequence.length; i++) {
        if (sequence[i].type === 'MediaSegment' && ++seen === count) {
            return sequence.slice(0, i + 1);
        }
    }
    return null;
}

function describeSequence(sequence) {
    return sequence
        .map((entry) => (entry.type === 'MediaSegment' ? 'media' : 'init') + ':' + entry.bytes)
        .join(', ');
}

Utils.getTestvectorsForTestcase(TESTCASE).forEach((item) => {
    const mpd = item.url;

    describe(`${TESTCASE} - ${item.name} - ${mpd}`, () => {
        let playerAdapter;
        let wasPlaying = false;

        before(async () => {
            // The log has to be wrapping XMLHttpRequest before the source is
            // attached. Attaching first leaves a window in which the opening
            // requests go out unrecorded, and this test compares sequences from
            // their first element, so one lost request fails it.
            playerAdapter = initializeDashJsAdapterWithoutAttachSource(item, defendedSettings());
            playerAdapter.startWireRequestLog();
            playerAdapter.attachSource(mpd);

            await checkDodgeActive(playerAdapter);
            wasPlaying = await playerAdapter.isInPlayingState(
                Constants.TEST_TIMEOUT_THRESHOLDS.IS_PLAYING);

            await playForDuration(OBSERVE_MS);
            observed[item.name] = responseSequenceByType(playerAdapter.getWireRequestLog());
        })

        after(() => {
            if (playerAdapter) {
                playerAdapter.destroy();
            }
        })

        it(`Checking playing state`, () => {
            // Recorded while the plan was still running. The plan is shorter than
            // the presentation, so by the end of the observation window the
            // defense has run out and the session is legitimately no longer
            // playing; asking now would be asking the wrong question.
            expect(wasPlaying, 'Expected the source to reach a playing state').to.be.true;
        })

        it(`Dodge defense is active`, async () => {
            await checkDodgeActive(playerAdapter);
        })

        it(`Enough of the plan reached the wire to compare`, () => {
            const byType = observed[item.name];
            expect(Object.keys(byType), 'Expected both media types on the wire')
                .to.include.members(['video', 'audio']);
            Object.keys(byType).forEach((type) => {
                // Both vectors defend an init segment on both media types,
                // so an init entry has to be there. Without this, the comparison
                // would still pass if init responses stopped being recorded on
                // both sources at once.
                expect(byType[type].some((entry) => entry.type === 'InitializationSegment'),
                    `No sized ${type} init segment response was observed`).to.be.true;
                expect(prefixThroughMediaSegment(byType[type], COMPARE_PREFIX),
                    `Fewer than ${COMPARE_PREFIX} sized ${type} media segment responses were observed`)
                    .to.not.be.null;
            });
        })

        it(`Expect no critical errors to be thrown`, () => {
            checkNoCriticalErrors(playerAdapter);
        })
    })
})

// Runs after every vector's describe above, so both sequences are in hand.
describe(`${TESTCASE} - the two sources are indistinguishable`, () => {

    it(`Both sources answer with the same response sizes in the same order`, () => {
        const names = Object.keys(observed);
        if (names.length < 2) {
            expect.fail(`Expected two sources in the anonymity set, saw ${JSON.stringify(names)}`);
        }

        const [first, second] = names;
        ['video', 'audio'].forEach((type) => {
            const a = prefixThroughMediaSegment(observed[first][type] || [], COMPARE_PREFIX);
            const b = prefixThroughMediaSegment(observed[second][type] || [], COMPARE_PREFIX);

            // Two sources that both stopped short would otherwise compare two
            // empty sequences and pass without having observed anything.
            if (!a || !b) {
                expect.fail(`Not enough ${type} media segments to compare: ` +
                    `${first} ${a ? 'reached' : 'did not reach'} ${COMPARE_PREFIX}, ` +
                    `${second} ${b ? 'reached' : 'did not reach'} ${COMPARE_PREFIX}`);
            }

            expect(a).to.deep.equal(b,
                `The two sources are distinguishable by ${type} response size.` +
                `\n  ${first}: ${describeSequence(a)}\n  ${second}: ${describeSequence(b)}`);
        });
    })
})
