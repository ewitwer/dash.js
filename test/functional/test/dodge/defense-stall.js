import Constants from '../../src/Constants.js';
import { expect } from 'chai';
import Utils from '../../src/Utils.js';

import {
    initializeDashJsAdapter,
    playForDuration
} from '../common/common.js';

import {
    checkDodgeActive,
    defendedSettings
} from '../common/dodge.js';

const TESTCASE = Constants.TESTCASES.DODGE.DEFENSE_STALL;

// When a defense can no longer run its cycles, it has to stop rather than carry
// on: requests that are no longer under cycle control are the traffic pattern
// the whole system exists to suppress. DodgeHandler stalls the stream and
// DodgeScheduleControllerOverride declines to schedule it again.
//
// That invariant is about what reaches the network, so it is asserted against
// the XHR log rather than against the request objects dash.js builds. The
// checks are that the stalled media type goes quiet, that the other one
// outlives it, and that a seek does not restart it.

// Let the defense get going before breaking it, so the stall lands mid-stream.
const REQUESTS_BEFORE_FAULT = 4;

// Long enough for the retry policy to run out (3 attempts) and for several
// schedule ticks to have passed afterwards.
const STALL_SETTLE_MS = 15000;

// A stalled stream must stay quiet across this window, even across a seek.
const QUIET_WINDOW_MS = 8000;

const VIDEO_URL_MARK = 'bbb_30fps_';
const AUDIO_URL_MARK = 'bbb_a64k';

function requestsMatching(log, mark) {
    return log.filter((entry) => entry.url.indexOf(mark) !== -1);
}

[
    {
        kind: 'notFound',
        label: 'a segment the origin does not serve'
    },
    {
        kind: 'ignoreRange',
        label: 'an origin that ignores the Range header',
        // Only reproduces anything on a defense that asks for part of a
        // segment. When every cycle asks for a whole one there is no Range
        // header to drop, so an origin that ignores Range answers byte for byte
        // what was expected and there is nothing for the runtime to detect.
        // The vectors that qualify say so in the stream configuration.
        requiresPartialRanges: true
    }
].forEach((fault) => {

    Utils.getTestvectorsForTestcase(TESTCASE).forEach((item) => {
        const mpd = item.url;

        if (fault.requiresPartialRanges && !item.dodgePartialRanges) {
            return;
        }

        describe(`${TESTCASE} - ${fault.label} - ${item.name} - ${mpd}`, () => {
            let playerAdapter;
            let videoAtStall = 0;

            before(async () => {
                playerAdapter = initializeDashJsAdapter(item, mpd, defendedSettings());

                // Order matters: the log wraps first so it records the faulted
                // request as it actually went out.
                playerAdapter.startWireRequestLog();

                await checkDodgeActive(playerAdapter);

                playerAdapter.startWireFaultInjection({
                    kind: fault.kind,
                    urlMatch: VIDEO_URL_MARK,
                    skip: REQUESTS_BEFORE_FAULT
                });

                await playForDuration(STALL_SETTLE_MS);

                const log = playerAdapter.getWireRequestLog();
                videoAtStall = requestsMatching(log, VIDEO_URL_MARK).length;
            })

            after(() => {
                if (playerAdapter) {
                    playerAdapter.destroy();
                }
            })

            it(`The fault was actually injected`, () => {
                // Without this the quiet assertions below would pass on a run
                // where nothing ever matched and nothing ever broke.
                expect(playerAdapter.getWireFaultCount()).to.be.above(REQUESTS_BEFORE_FAULT,
                    'Expected the fault rule to have matched more requests than it let through');
                expect(playerAdapter.getWireFaultAppliedCount()).to.be.above(0,
                    'Expected the fault to have been carried out on at least one request');
            })

            it(`The stalled media type stops reaching the wire`, async () => {
                await playForDuration(QUIET_WINDOW_MS);

                const log = playerAdapter.getWireRequestLog();
                const now = requestsMatching(log, VIDEO_URL_MARK).length;
                expect(now).to.equal(videoAtStall,
                    `Expected no further video requests after the stall, saw ${now - videoAtStall} more. ` +
                    'A stalled stream that keeps requesting is fetching outside cycle control');
            })

            it(`The stall is scoped to one media type`, () => {
                // The stall is recorded per stream and media type, so the other
                // one has to outlive it. Comparing when each type last reached
                // the wire rather than counting requests.
                const log = playerAdapter.getWireRequestLog();
                const lastAt = (mark) => requestsMatching(log, mark)
                    .reduce((max, entry) => Math.max(max, entry.timestamp), 0);

                const lastVideo = lastAt(VIDEO_URL_MARK);
                const lastAudio = lastAt(AUDIO_URL_MARK);
                expect(lastAudio).to.be.above(lastVideo,
                    'Expected audio to still be requesting after video went quiet, so the stall is scoped ' +
                    `to one media type (last video ${lastVideo}, last audio ${lastAudio})`);
            })

            it(`A seek does not restart the stalled stream`, async () => {
                // StreamProcessor restarts the schedule timer on a seek for any
                // media type, and on every fragment completion for text, which
                // is why the stall is enforced in _shouldClearScheduleTimer
                // rather than at the point of failure.
                const before = requestsMatching(playerAdapter.getWireRequestLog(), VIDEO_URL_MARK).length;

                playerAdapter.seek(Math.round(playerAdapter.getDuration() * 0.5));
                await playForDuration(QUIET_WINDOW_MS);

                const after = requestsMatching(playerAdapter.getWireRequestLog(), VIDEO_URL_MARK).length;
                expect(after).to.equal(before,
                    `Expected the seek not to restart the stalled stream, saw ${after - before} video requests`);
            })

            it(`The stall is reported in the error log`, () => {
                const errors = playerAdapter.getLogEvents()[dashjs.Debug.LOG_LEVEL_ERROR] || []; // jshint ignore:line
                const explained = errors.some((message) =>
                    message.indexOf('stalling') !== -1 || message.indexOf('Stalling') !== -1);
                expect(explained,
                    'Expected the stall to be explained in the error log, saw ' + JSON.stringify(errors)).to.be.true;
            })
        })
    })
})
