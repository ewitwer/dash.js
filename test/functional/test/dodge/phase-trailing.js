import Constants from '../../src/Constants.js';
import { expect } from 'chai';
import Utils from '../../src/Utils.js';

import {
    checkIsPlaying,
    checkNoCriticalErrors,
    initializeDashJsAdapter
} from '../common/common.js';

import {
    checkBufferBecomesPositive,
    checkBufferNeverNegative,
    checkDodgeActive,
    checkDodgeTrailing,
    defendedSettings,
    fetchExtendedManifest,
    minTrailingPaddingCount,
    trailingRequests
} from '../common/dodge.js';

const TESTCASE = Constants.TESTCASES.DODGE.PHASE_TRAILING;

// The trailing phase on a defense whose cycles run out before the presentation
// does. The player still has content to show, so the padding has to keep going
// without the position jumping to the end and without the reported buffer going
// negative underneath it.
//
// A defense whose cycles cover the whole presentation is the other case, and it
// ends in playback finishing rather than continuing. That one is
// phase-trailing-completion.

const COLLECTION_TIMEOUT = 90000;
const BUFFER_SAMPLE_MS = 5000;

// How close to the end the playhead may sit during trailing before the phase is
// judged to have let the position jump.
const END_MARGIN = 0.95;

Utils.getTestvectorsForTestcase(TESTCASE).forEach((item) => {
    const mpd = item.url;

    describe(`${TESTCASE} - ${item.name} - ${mpd}`, () => {
        let playerAdapter;
        let trafficPromise;
        let expectedPadding;
        let expectedTrailingBuffer;

        before(async () => {
            const manifest = await fetchExtendedManifest(mpd);
            expectedPadding = minTrailingPaddingCount(manifest);

            // Every stream in a fixture declares the same directive on its
            // trailing padding, so the first one settles the expectation.
            const trailing = manifest.streams[0].data.slice(-expectedPadding);
            expectedTrailingBuffer = trailing.length > 0 && !!trailing[0].buffer;

            playerAdapter = initializeDashJsAdapter(item, mpd, defendedSettings());
            trafficPromise = playerAdapter.collectDodgeTraffic(COLLECTION_TIMEOUT);
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

        it(`The mock buffer reports a positive level during the data cycles`, async () => {
            // Stop as soon as trailing starts: past that point an empty buffer
            // is the expected state and proves nothing either way. Reaching a
            // positive level here is also what keeps the non-negative check
            // below from passing on no samples at all.
            await checkBufferBecomesPositive(playerAdapter, 'video', 30000,
                () => playerAdapter.isDodgeTrailing());
        })

        it(`Trailing phase is reached`, async () => {
            await checkDodgeTrailing(playerAdapter);
        })

        it(`The reported buffer level never goes negative during trailing`, async () => {
            await checkBufferNeverNegative(playerAdapter, 'video', BUFFER_SAMPLE_MS);
        })

        it(`Playback position does not jump to stream end during trailing`, async () => {
            // A fraction rather than a fixed number of seconds: these vectors
            // declare a twelve second presentation, so the absolute margin this
            // replaces asked for a position below a negative time and could
            // only ever have been satisfied on a long one.
            const duration = playerAdapter.getDuration();
            await playerAdapter.sleep(3000);
            const currentTime = playerAdapter.getCurrentTime();
            expect(currentTime).to.be.below(duration * END_MARGIN,
                'Playback position jumped near stream end during trailing - gap jump suppression may have failed ' +
                '(duration=' + duration + ', currentTime=' + currentTime + ')');
        })

        it(`Every trailing padding cycle the manifest declares reaches the wire`, async () => {
            // Both media types are checked: Stream only ends the source once
            // every processor has finished, so audio and video each have to run
            // their padding to the end.
            const traffic = await trafficPromise;

            for (const mediaType of ['video', 'audio']) {
                const trailing = trailingRequests(traffic, mediaType);
                expect(trailing.length,
                    `Expected ${expectedPadding} trailing padding requests for ${mediaType}, saw ${trailing.length}`)
                    .to.be.at.least(expectedPadding);
            }
        })

        it(`Every trailing request is a padding cycle, with the buffer directive the manifest declares`, async () => {
            // Whether trailing padding carries the buffer directive is the
            // defense designer's choice, and it decides the pacing: a cycle that
            // carries it credits the mock buffer and so goes out at content
            // rate, one that does not contributes no simulated time.
            const traffic = await trafficPromise;

            for (const mediaType of ['video', 'audio']) {
                trailingRequests(traffic, mediaType).forEach((req, i) => {
                    expect(req.padding, `${mediaType} trailing cycle ${i}: expected a padding cycle`).to.be.true;
                    expect(!!req.buffer,
                        `${mediaType} trailing cycle ${i}: buffer directive should match the manifest`)
                        .to.equal(expectedTrailingBuffer);
                });
            }
        })

        it(`Expect no critical errors to be thrown`, () => {
            checkNoCriticalErrors(playerAdapter);
        })
    })
})
