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

function responseSizesByType(log) {
    const byType = {};
    log.forEach((entry) => {
        if (!entry.mediaType || entry.requestType !== 'MediaSegment' ||
                isNaN(entry.responseBytes) || entry.responseBytes <= 0) {
            return;
        }
        (byType[entry.mediaType] = byType[entry.mediaType] || []).push(entry.responseBytes);
    });
    return byType;
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
            observed[item.name] = responseSizesByType(playerAdapter.getWireRequestLog());
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
                expect(byType[type].length,
                    `Only ${byType[type].length} sized ${type} responses were observed, need ${COMPARE_PREFIX}`)
                    .to.be.at.least(COMPARE_PREFIX);
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
            const a = (observed[first][type] || []).slice(0, COMPARE_PREFIX);
            const b = (observed[second][type] || []).slice(0, COMPARE_PREFIX);

            expect(a).to.deep.equal(b,
                `The two sources are distinguishable by ${type} response size.` +
                `\n  ${first}: ${a.join(', ')}\n  ${second}: ${b.join(', ')}`);
        });
    })
})
