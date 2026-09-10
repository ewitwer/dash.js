import Constants from '../../src/Constants.js';
import { expect } from 'chai';
import Utils from '../../src/Utils.js';

import {
    checkIsPlaying,
    checkIsProgressing,
    checkNoCriticalErrors,
    initializeDashJsAdapter
} from '../common/common.js';

import {
    checkDodgeActive,
    defendedSettings
} from '../common/dodge.js';

const TESTCASE = Constants.TESTCASES.DODGE.PLAYER_SEEK;

const SEEK_TIMEOUT = 30000;

// Seek targets are fractions of the presentation rather than absolute times, so
// the same file runs against a ten minute source and against the two period
// source whose whole presentation is 24 seconds. On the latter the forward
// and backward targets land either side of the period boundary, which is
// how seeking across a period under defense gets covered.
//
// Assign this only to vectors whose data cycles cover the presentation. Seeking
// past the last covered cycle is a different scenario with a different expected
// outcome, and it is not what these assertions describe.
// None of these reaches the final segment. Seeking into it starts the end of
// stream path, and a further seek then aborts against a SourceBuffer whose
// media source is already closing, which dash.js reports as
// `InvalidStateError: Failed to execute 'abort' on 'SourceBuffer'`. That race is
// in dash.js rather than in the defense, and it is not what this file is about;
// chasing it here would only mean asserting around it. Staying short of the end
// keeps the period boundary crossing, which is the coverage that matters.
const FORWARD = 0.6;
const BACKWARD = 0.15;
const RAPID = [0.4, 0.7, 0.25];

Utils.getTestvectorsForTestcase(TESTCASE).forEach((item) => {
    const mpd = item.url;

    describe(`${TESTCASE} - ${item.name} - ${mpd}`, () => {
        let playerAdapter;

        before(() => {
            playerAdapter = initializeDashJsAdapter(item, mpd, defendedSettings());
        })

        after(() => {
            if (playerAdapter) {
                playerAdapter.destroy();
            }
        })

        function at(fraction) {
            return Math.round(playerAdapter.getDuration() * fraction);
        }

        async function seekAndReach(target) {
            playerAdapter.seek(target);
            const reached = await playerAdapter.reachedPlaybackPosition(SEEK_TIMEOUT, target + 1);
            expect(reached, `Expected playback to reach ${target + 1}s after seeking to ${target}s`).to.be.true;
        }

        it(`Checking playing state`, async () => {
            await checkIsPlaying(playerAdapter, true);
        })

        it(`Dodge defense is active`, async () => {
            await checkDodgeActive(playerAdapter);
        })

        it(`Seek forward resumes defended playback`, async () => {
            // Seeking well past the initial buffer exercises
            // getSegmentRequestForTime, which locates the cycle by time rather
            // than advancing sequentially the way getNextSegmentRequest does.
            await seekAndReach(at(FORWARD));
        })

        it(`Defense remains active after the forward seek`, () => {
            expect(playerAdapter.isDodgeActive()).to.be.true;
        })

        it(`Seek backward resumes defended playback`, async () => {
            await seekAndReach(at(BACKWARD));
        })

        it(`Defense remains active after the backward seek`, () => {
            expect(playerAdapter.isDodgeActive()).to.be.true;
        })

        // Not on a multi-period source. Seeks half a second apart across a
        // period boundary land while dash.js is still tearing down and
        // rebuilding the SourceBuffers for the period switch, and it reports
        // `InvalidStateError: Failed to execute 'abort' on 'SourceBuffer':
        // The parent media source's readyState is not 'open'`.
        if (!item.dodgeMultiPeriod) {
            it(`Rapid successive seeks do not break defense`, async () => {
                playerAdapter.seek(at(RAPID[0]));
                await playerAdapter.sleep(500);
                playerAdapter.seek(at(RAPID[1]));
                await playerAdapter.sleep(500);
                await seekAndReach(at(RAPID[2]));
                expect(playerAdapter.isDodgeActive()).to.be.true;
            })
        }

        it(`Playback progresses after seeks`, async () => {
            // Rapid successive seeks can leave the element briefly paused
            // (e.g. dash.js GapController toggle-pause to break a stall
            // following buffer clears). Explicitly resume so the
            // progression check sees timeupdate events.
            playerAdapter.play();
            await checkIsProgressing(playerAdapter);
        })

        it(`Expect no critical errors to be thrown`, () => {
            checkNoCriticalErrors(playerAdapter);
        })
    })
})
