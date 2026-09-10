import Constants from '../../src/Constants.js';
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

const TESTCASE = Constants.TESTCASES.DODGE.DEFENSE_BASELINE;

// The health check every defended vector gets: the source plays, the defense
// takes over, playback advances, and nothing errors.
//
// It is deliberately assigned to vectors whose own test file asserts one narrow
// behavior and nothing about the session around it. Where defense-verification
// runs, this would be a strict subset of it and is left off.

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

        it(`Checking playing state`, async () => {
            await checkIsPlaying(playerAdapter, true);
        })

        it(`Dodge defense is active`, async () => {
            await checkDodgeActive(playerAdapter);
        })

        it(`Checking progressing state`, async () => {
            await checkIsProgressing(playerAdapter);
        })

        it(`Expect no critical errors to be thrown`, () => {
            checkNoCriticalErrors(playerAdapter);
        })
    })
})
