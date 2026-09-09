import Constants from '../../src/Constants.js';
import {expect} from 'chai';
import Utils from '../../src/Utils.js';
import MediaPlayerEvents from '../../../../src/streaming/MediaPlayerEvents.js';

import {
    checkIsPlaying,
    checkIsProgressing,
    checkNoCriticalErrors,
    initializeDashJsAdapter
} from '../common/common.js';

const TESTCASE = Constants.TESTCASES.DODGE.SEEK_TRAILING;

Utils.getTestvectorsForTestcase(TESTCASE).forEach((item) => {
    const mpd = item.url;

    describe(`${TESTCASE} - ${item.name} - ${mpd}`, () => {
        let playerAdapter;
        let endedBeforeSeek = 0;
        let seekedAt = 0;
        // Trailing requests, recorded as they are issued. isDodgeTrailing() is
        // a transient: the phase can open and close inside one polling interval,
        // and by the time a later test looks the cursor is already past the last
        // cycle. What the phase leaves behind is its padding on the wire.
        const trailingRequests = [];

        before(() => {
            playerAdapter = initializeDashJsAdapter(item, mpd, {
                streaming: {
                    abr: {
                        autoSwitchBitrate: { video: false, audio: false }
                    }
                }
            });
            playerAdapter.registerEvent(MediaPlayerEvents.PLAYBACK_ENDED);
            playerAdapter.registerEvent(MediaPlayerEvents.FRAGMENT_LOADING_STARTED, (e) => {
                if (e && e.request && e.request.trail === true) {
                    trailingRequests.push({ mediaType: e.request.mediaType, time: Date.now() });
                }
            });
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

        it(`Trailing phase is reached`, async () => {
            const timeout = 30000;
            const start = Date.now();
            let isTrailing = false;
            while (Date.now() - start < timeout) {
                isTrailing = playerAdapter.isDodgeTrailing();
                if (isTrailing) {
                    break;
                }
                await playerAdapter.sleep(500);
            }
            expect(isTrailing, 'Expected isDodgeTrailing() to become true').to.be.true;
        })

        it(`Seek backward during trailing does not crash`, async () => {
            // PlaybackController may already have ended the stream during this
            // first trailing phase, so record the count now: the assertion at the
            // end needs a *new* PLAYBACK_ENDED, not the one from before the seek.
            endedBeforeSeek = playerAdapter.getEventTriggerCount(MediaPlayerEvents.PLAYBACK_ENDED);
            seekedAt = Date.now();
            playerAdapter.seek(0);
            await playerAdapter.sleep(2000);
            expect(playerAdapter.isDodgeActive()).to.be.true;
        })

        it(`Buffer level is non-negative after seek during trailing`, () => {
            // getBufferLength() reports NaN for an empty buffer, because upstream
            // returns `buffer ? buffer : NaN` and 0 is falsy. A seek during
            // trailing prunes the buffer, so an empty one is a legitimate outcome
            // here and says nothing about the mock buffer. Only a real number can.
            const videoBuffer = playerAdapter.getBufferLengthByType('video');
            if (typeof videoBuffer === 'number' && !isNaN(videoBuffer)) {
                expect(videoBuffer).to.be.at.least(0,
                    'Video buffer should not be negative after a seek during trailing');
            }
        })

        it(`Playback progresses after seek`, async () => {
            // PLAYBACK_ENDED fires during trailing once isLastSegmentRequested
            // returns true and the playable buffer drains; PlaybackController
            // then pauses the video element. Seeking backward moves currentTime
            // but leaves the element paused, so timeupdate never fires and the
            // progression check would time out. Explicitly resume playback.
            playerAdapter.play();
            await checkIsProgressing(playerAdapter);
        })

        it(`The defense sends its trailing padding again after the seek`, async () => {
            // Seeking backward rewinds the cycle cursor into the data cycles, so
            // the defense has to walk forward to its trailing padding a second
            // time. The buffering completion deferral is armed per phase for
            // exactly this reason: on a defense whose cycles cover the whole
            // presentation the period is fully buffered again by the time the
            // second phase starts, and a deferral that only armed once would let
            // ScheduleController refuse to arm its timer, so no padding would go
            // out at all.
            const timeout = 60000;
            const start = Date.now();
            let afterSeek = [];
            while (Date.now() - start < timeout) {
                afterSeek = trailingRequests.filter((r) => r.time > seekedAt);
                if (afterSeek.length >= 2) {
                    break;
                }
                await playerAdapter.sleep(250);
            }
            expect(afterSeek.length,
                'Expected the trailing padding cycles to be requested again after seeking back into the content cycles, ' +
                'saw ' + afterSeek.length)
                .to.be.at.least(2);
        })

        it(`Playback still finishes after a seek out of the trailing phase`, async () => {
            // The deferral has to be handed back at the end of the second phase
            // too. If it is only released once per session the stream stays
            // alive forever after a seek: the padding goes out, the cycles run
            // out, and nothing ever ends the media source.
            const timeout = 60000;
            const start = Date.now();
            let ended = false;
            while (Date.now() - start < timeout) {
                ended = playerAdapter.getEventTriggerCount(MediaPlayerEvents.PLAYBACK_ENDED) > endedBeforeSeek;
                if (ended) {
                    break;
                }
                await playerAdapter.sleep(250);
            }
            expect(ended, 'Expected a new PLAYBACK_ENDED after the trailing phase that followed the seek; the deferred buffering completion was never released a second time').to.be.true;
        })

        it(`Expect no critical errors to be thrown`, () => {
            checkNoCriticalErrors(playerAdapter);
        })
    })
})
