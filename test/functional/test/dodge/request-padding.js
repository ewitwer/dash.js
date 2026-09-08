import Constants from '../../src/Constants.js';
import {expect} from 'chai';
import Utils from '../../src/Utils.js';

import {
    checkIsPlaying,
    checkNoCriticalErrors,
    initializeDashJsAdapter
} from '../common/common.js';

const TESTCASE = Constants.TESTCASES.DODGE.REQUEST_PADDING;

// Segments come from the content host; the page itself is served by karma. Only
// the former go through Dodge's request generation, so only those are measured.
const CONTENT_HOST = 'dash.akamaized.net';

const PADDING_BASE = 1024;
const PADDING_RANDOM = 32;

// Enough requests that a single mis-sized one cannot hide, and long enough for
// them to arrive at one segment per random-walk interval.
const SAMPLE_SIZE = 8;
const SAMPLE_TIMEOUT = 30000;

/**
 * Clear the wire log, then wait for `count` fresh segment requests.
 */
async function sampleWireRequests(playerAdapter, count, timeout) {
    playerAdapter.clearWireRequestLog();
    const start = Date.now();
    let requests = [];
    while (Date.now() - start < timeout) {
        requests = playerAdapter.getWireRequestLog().filter(entry => entry.url.indexOf(CONTENT_HOST) !== -1);
        if (requests.length >= count) {
            break;
        }
        await playerAdapter.sleep(200);
    }
    return requests;
}

function describeRequest(entry) {
    return `${entry.size} bytes (url ${entry.urlLength} + headers ${entry.headerBytes}) for ${entry.url}`;
}

Utils.getTestvectorsForTestcase(TESTCASE).forEach((item) => {
    const mpd = item.url;

    describe(`${TESTCASE} - ${item.name} - ${mpd}`, () => {
        let playerAdapter;

        before(() => {
            playerAdapter = initializeDashJsAdapter(item, mpd, {
                streaming: {
                    abr: {
                        autoSwitchBitrate: { video: false, audio: false }
                    },
                    // Keep segments flowing for the whole run. At the default
                    // buffer target the player goes quiet once it is full, and
                    // each phase below needs a fresh sample.
                    buffer: {
                        bufferTimeDefault: 120,
                        bufferTimeAtTopQuality: 120,
                        bufferTimeAtTopQualityLongForm: 120
                    }
                },
                dodge: {
                    paddingLengthBase: PADDING_BASE,
                    paddingLengthRandom: PADDING_RANDOM
                }
            });
            playerAdapter.startWireRequestLog();
        })

        after(() => {
            if (playerAdapter) {
                playerAdapter.stopWireRequestLog();
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

        it(`Every request leaves the browser within the configured size range`, async () => {
            const requests = await sampleWireRequests(playerAdapter, SAMPLE_SIZE, SAMPLE_TIMEOUT);

            expect(requests.length,
                'No segment requests were observed on XMLHttpRequest, so nothing was measured')
                .to.be.at.least(SAMPLE_SIZE);

            for (const entry of requests) {
                expect(entry.size, `Request outside the padded range: ${describeRequest(entry)}`)
                    .to.be.within(PADDING_BASE, PADDING_BASE + PADDING_RANDOM);
            }
        })

        it(`Request size varies within the random component`, async () => {
            const requests = await sampleWireRequests(playerAdapter, SAMPLE_SIZE, SAMPLE_TIMEOUT);
            const sizes = new Set(requests.map(entry => entry.size));

            // paddingLengthRandom is what stops every request being the same
            // recognizable length. With 33 possible values over this many
            // requests, one distinct size means the random draw is not reaching
            // the wire.
            expect(sizes.size,
                `Expected padded sizes to vary, saw only ${Array.from(sizes).join(', ')}`)
                .to.be.above(1);
        })

        it(`With paddingLengthRandom at zero every request is exactly paddingLengthBase`, async () => {
            playerAdapter.updateSettings({ dodge: { paddingLengthRandom: 0 } });

            const requests = await sampleWireRequests(playerAdapter, SAMPLE_SIZE, SAMPLE_TIMEOUT);
            expect(requests.length, 'No segment requests were observed').to.be.at.least(SAMPLE_SIZE);

            for (const entry of requests) {
                expect(entry.size, `Request not normalized to paddingLengthBase: ${describeRequest(entry)}`)
                    .to.equal(PADDING_BASE);
            }
        })

        it(`With paddingLengthBase at zero requests go out unpadded`, async () => {
            playerAdapter.updateSettings({ dodge: { paddingLengthBase: 0 } });

            const requests = await sampleWireRequests(playerAdapter, SAMPLE_SIZE, SAMPLE_TIMEOUT);
            expect(requests.length, 'No segment requests were observed').to.be.at.least(SAMPLE_SIZE);

            for (const entry of requests) {
                expect(entry.size, `Padding was applied although paddingLengthBase is 0: ${describeRequest(entry)}`)
                    .to.be.below(PADDING_BASE);
            }
        })

        it(`Expect no critical errors to be thrown`, () => {
            checkNoCriticalErrors(playerAdapter);
        })
    })
})
