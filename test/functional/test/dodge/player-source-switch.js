import Constants from '../../src/Constants.js';
import {expect} from 'chai';
import Utils from '../../src/Utils.js';

import {
    checkIsPlaying,
    checkIsProgressing,
    checkNoCriticalErrors,
    initializeDashJsAdapter
} from '../common/common.js';

import {
    checkDodgeActive,
} from '../common/dodge.js';

const TESTCASE = Constants.TESTCASES.DODGE.PLAYER_SOURCE_SWITCH;

// A plain MPD, so the second source carries no extended manifest at all.
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
            await checkDodgeActive(playerAdapter);
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
