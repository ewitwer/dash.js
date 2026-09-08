import Constants from '../../src/Constants.js';
import {expect} from 'chai';
import Utils from '../../src/Utils.js';

import {
    checkIsPlaying,
    checkIsProgressing,
    checkNoCriticalErrors,
    initializeDashJsAdapter
} from '../common/common.js';

const TESTCASE = Constants.TESTCASES.DODGE.SOURCE_SWITCH;

// A plain MPD, so the second source carries no extended manifest at all. That is
// the case the registry used to survive: it is never handed anything that parses
// as an extended manifest, so nothing on the manifest path drops what the first
// source left behind.
const PLAIN_MPD = 'https://dash.akamaized.net/dash264/TestCases/1a/sony/SNE_DASH_SD_CASE1A_REVISED.mpd';

Utils.getTestvectorsForTestcase(TESTCASE).forEach((item) => {
    const mpd = item.url;

    describe(`${TESTCASE} - ${item.name} - ${mpd}`, () => {
        let playerAdapter;

        before(() => {
            // The default strict mode. An undefended representation is blocked
            // while a defense is registered, which is what turns a stale
            // registry into a player that never requests anything again.
            playerAdapter = initializeDashJsAdapter(item, mpd, {
                dodge: { strictMode: 'representation' }
            });
        })

        after(() => {
            if (playerAdapter) {
                playerAdapter.destroy();
            }
        })

        it(`Checking playing state on the defended source`, async () => {
            await checkIsPlaying(playerAdapter, true);
        })

        it(`Dodge defense is active on the defended source`, async () => {
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

        it(`Switching to a plain MPD plays`, async () => {
            playerAdapter.attachSource(PLAIN_MPD);
            await checkIsPlaying(playerAdapter, true);
        })

        it(`Switching to a plain MPD keeps progressing`, async () => {
            // The failure this guards against is a player that is "playing" but
            // never advances, because every segment request is refused against a
            // defense belonging to the previous source.
            await checkIsProgressing(playerAdapter);
        })

        it(`The previous source's defense is no longer reported as active`, () => {
            expect(playerAdapter.isDodgeActive()).to.be.false;
        })

        it(`Expect no critical errors to be thrown`, () => {
            checkNoCriticalErrors(playerAdapter);
        })
    })
})
