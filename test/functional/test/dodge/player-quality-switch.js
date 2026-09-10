import Constants from '../../src/Constants.js';
import {expect} from 'chai';
import Utils from '../../src/Utils.js';

import {
    checkIsProgressing,
    checkNoCriticalErrors,
    initializeDashJsAdapter,
    playForDuration
} from '../common/common.js';

const TESTCASE = Constants.TESTCASES.DODGE.PLAYER_QUALITY_SWITCH;

// Long enough at the starting quality that a restart is unmistakable, then long
// enough for ABR to act on the raised cap and fetch at the new quality.
const PRE_SWITCH_MS = 14000;
const POST_SWITCH_MS = 18000;

// An initial bitrate this low resolves to the lowest video representation
// whatever the player has cached from an earlier session in the same browser,
// so playback starts from a known quality. A maxBitrate cap would do the same
// but also hides the other representations from the player, which is not what
// this test wants.
const STARTING_BITRATE_KBPS = 1;

const BUFFER_TARGET_S = 8;

Utils.getTestvectorsForTestcase(TESTCASE).forEach((item) => {
    const mpd = item.url;

    describe(`${TESTCASE} - ${item.name} - ${mpd}`, () => {
        let playerAdapter;
        let traffic;
        let startingId;
        let targetId;
        let lastIndexBeforeSwitch;

        before(async () => {
            playerAdapter = initializeDashJsAdapter(item, mpd, {
                streaming: {
                    abr: {
                        initialBitrate: { video: STARTING_BITRATE_KBPS },
                        autoSwitchBitrate: { video: false, audio: false }
                    },
                    buffer: {
                        bufferTimeDefault: BUFFER_TARGET_S
                    }
                }
            });

            // One continuous collection rather than one window per phase, so
            // that no request can slip through a gap between two windows. The
            // requests are told apart by representation, not by time.
            const collecting = playerAdapter.collectDodgeTraffic(PRE_SWITCH_MS + POST_SWITCH_MS);
            await playForDuration(PRE_SWITCH_MS);

            // Handing ABR back the wheel over a healthy buffer and a fast
            // connection moves it up at one of the buffer events that follow.
            // Driving the switch through ABR rather than through
            // setRepresentationForTypeById is deliberate: an ABR switch arrives
            // between two media requests, which is the path that has to resume
            // the cycle sequence. A manual switch clears the buffer ahead of the
            // play head first and comes back through the seek path instead.
            playerAdapter.updateSettings({
                streaming: {
                    abr: {
                        autoSwitchBitrate: { video: true }
                    }
                }
            });

            traffic = await collecting;

            // Both representations are read off the traffic rather than from the
            // player, so the test does not depend on how the representation list
            // is ordered or filtered.
            const firstVideo = traffic.find(t => t.mediaType === Constants.DASH_JS.MEDIA_TYPES.VIDEO);
            startingId = firstVideo ? firstVideo.representationId : null;
            const switchedTo = traffic.find(t => t.mediaType === Constants.DASH_JS.MEDIA_TYPES.VIDEO &&
                t.representationId !== startingId);
            targetId = switchedTo ? switchedTo.representationId : null;

            lastIndexBeforeSwitch = traffic
                .filter(t => t.mediaType === Constants.DASH_JS.MEDIA_TYPES.VIDEO &&
                    t.type === Constants.SEGMENT_TYPES.MEDIA &&
                    t.representationId === startingId)
                .reduce((max, t) => (t.index > max ? t.index : max), -1);
        })

        after(() => {
            if (playerAdapter) {
                playerAdapter.destroy();
            }
        })

        function videoTrafficByRepresentation() {
            const counts = {};
            traffic.filter(t => t.mediaType === Constants.DASH_JS.MEDIA_TYPES.VIDEO).forEach(t => {
                const key = t.representationId + ' ' + t.type;
                counts[key] = (counts[key] || 0) + 1;
            });
            return JSON.stringify(counts);
        }

        it(`Dodge defense is active`, () => {
            expect(playerAdapter.isDodgeActive()).to.be.true; // jshint ignore:line
        })

        it(`The starting quality played several segments before ABR was handed back the wheel`, () => {
            // Without this the assertions below would hold trivially: a restart
            // at index 0 is only visible once playback has moved on from it.
            expect(lastIndexBeforeSwitch).to.be.at.least(2,
                'Expected several defended segments at ' + startingId + ', saw ' + videoTrafficByRepresentation());
        })

        it(`The new representation's init segment is requested before any of its media segments`, () => {
            const forTarget = traffic.filter(t => t.mediaType === Constants.DASH_JS.MEDIA_TYPES.VIDEO &&
                t.representationId === targetId);

            // An empty set means ABR never moved off the starting quality,
            // which is a different failure from the ordering this pins, so name
            // what was actually fetched.
            expect(forTarget.length).to.be.above(0,
                'Expected a switch away from ' + startingId + ', saw ' + videoTrafficByRepresentation());
            expect(forTarget[0].type).to.equal(Constants.SEGMENT_TYPES.INIT,
                'Expected the first request for the new representation to be its init segment');
        })

        it(`The new representation resumes where the old one left off`, () => {
            const firstMedia = traffic.find(t => t.mediaType === Constants.DASH_JS.MEDIA_TYPES.VIDEO &&
                t.representationId === targetId &&
                t.type === Constants.SEGMENT_TYPES.MEDIA);

            expect(firstMedia, 'Expected a media segment after the switch, saw ' + videoTrafficByRepresentation()).to.exist; // jshint ignore:line
            // The resume point is the segment index last requested, re-fetched
            // at the new quality. At least, rather than exactly, because dash.js
            // may route a switch through the seek path, which resolves against
            // the buffering time and lands one segment further on. What
            // neither path may do is start the video over.
            expect(firstMedia.index).to.be.at.least(lastIndexBeforeSwitch,
                'Expected the new representation to resume at segment ' + lastIndexBeforeSwitch + ' rather than restart');
        })

        it(`Playback progresses after the switch`, async () => {
            await checkIsProgressing(playerAdapter);
        })

        it(`Expect no critical errors to be thrown`, () => {
            checkNoCriticalErrors(playerAdapter);
        })
    })
})
