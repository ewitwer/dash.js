import Constants from '../../src/Constants.js';
import Utils from '../../src/Utils.js';

import {
    checkIsNotProgressing,
    initializeDashJsAdapter,
    playForDuration
} from '../common/common.js';

import {
    checkDodgeActive,
    checkDodgeNotActive,
    defendedSettings
} from '../common/dodge.js';

const TESTCASE = Constants.TESTCASES.DODGE.POLICY_UNSHAPED_TRACKS;

// rejectIfUnshapedTracks covers tracks and references that fetch outside cycle
// control: thumbnail tiles, non-fragmented sidecar text, XLink references, and
// event streams with network side effects. Each branch has its own vector; the
// policy around all of them is the same, so it is asserted once here.
//
// Under 'max' the source is refused outright. Under the default mode and with
// strict mode off it is allowed, with a warning in the log that this file does
// not read: what matters to a deployer is whether the source plays.

const REJECT_ATTEMPT_MS = 5000;
const ALLOW_ATTEMPT_MS = 8000;

Utils.getTestvectorsForTestcase(TESTCASE).forEach((item) => {
    const mpd = item.url;

    describe(`${TESTCASE} - ${item.name} - ${mpd}`, () => {

        describe(`with strictMode max`, () => {
            let playerAdapter;

            before(async () => {
                playerAdapter = initializeDashJsAdapter(item, mpd,
                    defendedSettings({ dodge: { strictMode: 'max' } }));
                await playForDuration(REJECT_ATTEMPT_MS);
            })

            after(() => {
                if (playerAdapter) {
                    playerAdapter.destroy();
                }
            })

            it(`Dodge defense should not be active (the source is rejected)`, () => {
                checkDodgeNotActive(playerAdapter);
            })

            it(`Playback should not progress`, async () => {
                await checkIsNotProgressing(playerAdapter);
            })
        })

        describe(`with the default strict mode`, () => {
            let playerAdapter;

            before(async () => {
                playerAdapter = initializeDashJsAdapter(item, mpd);
                await playForDuration(ALLOW_ATTEMPT_MS);
            })

            after(() => {
                if (playerAdapter) {
                    playerAdapter.destroy();
                }
            })

            it(`Dodge defense should be active (warning only, not blocked)`, async () => {
                await checkDodgeActive(playerAdapter);
            })
        })

        describe(`with strict mode off`, () => {
            let playerAdapter;

            before(async () => {
                playerAdapter = initializeDashJsAdapter(item, mpd,
                    defendedSettings({ dodge: { strictMode: false } }));
                await playForDuration(ALLOW_ATTEMPT_MS);
            })

            after(() => {
                if (playerAdapter) {
                    playerAdapter.destroy();
                }
            })

            it(`Dodge defense should be active (no unshaped track check when strict mode off)`, async () => {
                await checkDodgeActive(playerAdapter);
            })
        })
    })
})
