import Constants from '../../src/Constants.js';
import {expect} from 'chai';
import Utils from '../../src/Utils.js';

import {
    checkIsPlaying,
    initializeDashJsAdapter
} from '../common/common.js';

import {
    checkDodgeActive,
} from '../common/dodge.js';

const TESTCASE = Constants.TESTCASES.DODGE.POLICY_TEXT_TRACKS;

Utils.getTestvectorsForTestcase(TESTCASE).forEach((item) => {
    const mpd = item.url;

    describe(`${TESTCASE} - ${item.name} - ${mpd}`, () => {
        let playerAdapter;
        let trafficPromise;

        before(() => {
            playerAdapter = initializeDashJsAdapter(item, mpd, {
                streaming: {
                    abr: {
                        autoSwitchBitrate: { video: false, audio: false }
                    }
                }
            });

            trafficPromise = playerAdapter.collectDodgeTraffic(
                Constants.TEST_TIMEOUT_THRESHOLDS.DODGE_TRAFFIC_COLLECTION
            );
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

        it(`No text segment requests are made`, async () => {
            const traffic = await trafficPromise;

            // The text track has no defense entry. In strict mode,
            // the text StreamProcessor should not fetch any segments.
            const textRequests = traffic.filter(t => t.mediaType === 'text');
            expect(textRequests.length).to.equal(0, 'Expected no text segment requests (undefended text should be blocked by strict mode)');
        })
    })
})
