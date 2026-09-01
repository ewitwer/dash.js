import DefenseRegistry, {
    isValidExtendedManifest,
    getCycleIndexBySegmentIndex
} from '../../../../src/dodge/DefenseRegistry.js';
import Debug from '../../../../src/core/Debug.js';

import { expect } from 'chai';

function makeValidManifest() {
    return {
        start: { mpd: '<MPD/>', base_uri: 'https://example.com/' },
        streams: [{
            label: 'video_1000k',
            init: [{ range: '0-855' }],
            data: [
                { index: 0, range: '0-43999' }, // cycle 0, partial, non-padding
                { index: 0, range: '44000-', buffer: true }, // cycle 1, non-padding
                { index: 1, buffer: true }, // cycle 2, non-padding
            ]
        }]
    };
}

describe('DefenseRegistry', function () {

    // isValidExtendedManifest

    describe('isValidExtendedManifest', function () {

        it('null, false', function () {
            expect(isValidExtendedManifest(null)).to.be.false; // jshint ignore:line
        });

        it('missing start, false', function () {
            expect(isValidExtendedManifest({ streams: [{ label: 'a', init: [{}], data: [{ index: 0, buffer: true }] }] })).to.be.false; // jshint ignore:line
        });

        it('missing start.mpd, false', function () {
            expect(isValidExtendedManifest({ start: { base_uri: 'https://x.com/' }, streams: [] })).to.be.false; // jshint ignore:line
        });

        it('missing start.base_uri, false', function () {
            expect(isValidExtendedManifest({ start: { mpd: '<MPD/>' }, streams: [] })).to.be.false; // jshint ignore:line
        });

        it('dynamic MPD is not gated by structural validation', function () {
            const m = {
                start: { mpd: '<MPD type="dynamic"/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('missing streams, false', function () {
            expect(isValidExtendedManifest({ start: { mpd: '<MPD/>', base_uri: 'https://x.com/' } })).to.be.false; // jshint ignore:line
        });

        it('empty streams array with valid start, false', function () {
            // An empty array passes a plain truthiness check but matches no
            // representation; accepting it would make hasContent() true and
            // permanently block all playback under strict mode.
            expect(isValidExtendedManifest({ start: { mpd: '<MPD/>', base_uri: 'https://x.com/' }, streams: [] })).to.be.false; // jshint ignore:line
        });

        it('non-array streams with valid start, false', function () {
            expect(isValidExtendedManifest({ start: { mpd: '<MPD/>', base_uri: 'https://x.com/' }, streams: {} })).to.be.false; // jshint ignore:line
        });

        it('stream missing label, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ init: [{}], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('stream with valid period (non-negative integer), true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', period: 0, init: [{}], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('stream with period = null (absent), true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', period: null, init: [{}], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('stream with negative period, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', period: -1, init: [{}], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('stream with non-integer period, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', period: 1.5, init: [{}], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('stream with numeric string period, coerced to integer, true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', period: '2', init: [{}], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
            expect(m.streams[0].period).to.equal(2); // coerced in place
        });

        it('stream with non-numeric string period, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', period: 'abc', init: [{}], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('stream missing init (data-only stream), true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('stream missing data (init-only stream), true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('stream with both init and data absent, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a' }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('stream with empty init and empty data, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [], data: [] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('stream with empty init array (self-initializing stream), true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [], data: [{ index: 0, range: '0-999' }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('stream with empty data array (init-only stream), true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{ range: '0-499' }], data: [] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('init cycle with non-string range, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{ range: 123 }], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('init cycle with range start > end, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{ range: '100-50' }], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        // "-855" is a suffix-byte-range-spec under RFC 7233 section 2.1 and asks
        // for the LAST 855 bytes, not bytes 0 through 855.
        it('init cycle with an omitted range start, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{ range: '-855' }], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        // An omitted END is a plain byte-range-spec and stays valid; the
        // assembler recomputes the end from the response length.
        it('init cycle with an omitted range end, true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{ range: '44-' }], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('init cycle buffer flag on non-last cycle is allowed (per-run termination)', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{ range: '0-99', buffer: true }, { range: '100-199', buffer: true }], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('init cycle buffer flag on last cycle only, true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{ range: '0-99' }, { range: '100-199', buffer: true }], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('init cycles with no buffer flags at all, true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{ range: '0-99' }, { range: '100-199' }], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('init cycle with array buffer, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{ range: '0-99', buffer: [0] }], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('init cycle with buffer string "true", true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{ range: '0-99', buffer: 'true' }], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('init cycle with buffer string "false", true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{ range: '0-99', buffer: 'false' }], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('init cycle with non-parseable string buffer, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{ range: '0-99', buffer: 'yes' }], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('init cycle with non-boolean buffer (number), false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{ range: '0-99', buffer: 1 }], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('init cycle with padding = true, true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{ range: '0-99', padding: true }], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('init cycle with padding string "true", true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{ range: '0-99', padding: 'true' }], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('init cycle with padding string "false", true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{ range: '0-99', padding: 'false' }], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('init cycle with non-parseable string padding, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{ range: '0-99', padding: 'yes' }], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('init cycle with non-boolean padding (number), false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{ range: '0-99', padding: 1 }], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('init cycle with non-string range (number), false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{ range: 99 }], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('data cycle with buffer = [0, 2] (array of non-negative integers), true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0 }, { index: 1 }, { index: 2, buffer: [0, 2] }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('data cycle with buffer = [] (empty array), true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, buffer: [] }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('data cycle with buffer = [1, -1] (negative index in array), false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, buffer: [1, -1] }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('data cycle with buffer = [1.5] (non-integer in array), false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, buffer: [1.5] }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('data cycle with buffer = ["abc"] (non-numeric in array), false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, buffer: ['abc'] }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('data cycle with buffer = [5] referencing unseen index, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, buffer: [5] }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('data cycle with buffer = [0, 3] where index 3 has not appeared, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [
                    { index: 0 },
                    { index: 1, buffer: [0, 3] }
                ] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('data cycle with buffer string "true", true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, buffer: 'true' }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('data cycle with buffer string "false", true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, buffer: 'false' }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('data cycle with non-parseable string buffer, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, buffer: 'yes' }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('data cycle with buffer = 1 (number), false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, buffer: 1 }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('data cycle with negative index, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: -1, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });


        it('data cycle with non-integer index, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 1.5, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('data cycle with string integer index, true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: '0', buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('data cycle with non-numeric string index, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 'abc', buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('data cycle with non-string range, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, range: 123, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        // Assembled byte ranges must leave no gap
        //
        // _concatPartialSegments sizes the result from the lowest range start to
        // the highest range end and writes each piece at its offset, so a hole
        // between two pieces is appended as zeros with nothing reported. Overlap
        // is fine: pieces are written over each other, and redundant coverage is
        // a legitimate defense lever.

        function ranged(cycles) {
            return {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: cycles }]
            };
        }

        it('data cycle ranges that tile the segment, true', function () {
            expect(isValidExtendedManifest(ranged([
                { index: 0, range: '0-499' },
                { index: 0, range: '500-999', buffer: true }
            ]))).to.be.true; // jshint ignore:line
        });

        it('data cycle ranges with a gap, false', function () {
            expect(isValidExtendedManifest(ranged([
                { index: 0, range: '0-499' },
                { index: 0, range: '600-999', buffer: true }
            ]))).to.be.false; // jshint ignore:line
        });

        it('data cycle ranges that overlap, true', function () {
            expect(isValidExtendedManifest(ranged([
                { index: 0, range: '0-599' },
                { index: 0, range: '500-999', buffer: true }
            ]))).to.be.true; // jshint ignore:line
        });

        it('data cycle ranges given out of order that still tile, true', function () {
            expect(isValidExtendedManifest(ranged([
                { index: 0, range: '500-999' },
                { index: 0, range: '0-499', buffer: true }
            ]))).to.be.true; // jshint ignore:line
        });

        // A padding response is never accumulated, so its range cannot fill a hole.
        it('a padding cycle does not close a gap, false', function () {
            expect(isValidExtendedManifest(ranged([
                { index: 0, range: '0-499' },
                { index: 0, range: '500-999', padding: true },
                { index: 0, range: '1000-1499', buffer: true }
            ]))).to.be.false; // jshint ignore:line
        });

        it('a single ranged cycle, true', function () {
            expect(isValidExtendedManifest(ranged([{ index: 0, range: '0-999', buffer: true }]))).to.be.true; // jshint ignore:line
        });

        // No range means the whole segment, so nothing can be missing.
        it('a cycle without a range, true', function () {
            expect(isValidExtendedManifest(ranged([
                { index: 0, range: '0-499' },
                { index: 0, buffer: true }
            ]))).to.be.true; // jshint ignore:line
        });

        it('an open-ended range covers everything after it, true', function () {
            expect(isValidExtendedManifest(ranged([
                { index: 0, range: '0-499' },
                { index: 0, range: '500-', buffer: true }
            ]))).to.be.true; // jshint ignore:line
        });

        it('each segment index is checked separately, false', function () {
            expect(isValidExtendedManifest(ranged([
                { index: 0, range: '0-499' },
                { index: 0, range: '500-999' },
                { index: 1, range: '0-499' },
                { index: 1, range: '600-999', buffer: true }
            ]))).to.be.false; // jshint ignore:line
        });

        // Each assembly is its own group: the same index fetched again after a
        // flush starts over rather than continuing the previous run.
        it('ranges are grouped per assembly, not per stream, true', function () {
            expect(isValidExtendedManifest(ranged([
                { index: 0, range: '0-499' },
                { index: 0, range: '500-999', buffer: true },
                { index: 0, range: '0-499' },
                { index: 0, range: '500-999', buffer: true }
            ]))).to.be.true; // jshint ignore:line
        });

        // The assembler matches pieces by representation, so cycles fetched at a
        // different quality form a separate group and cannot fill each other's holes.
        it('quality override cycles form their own group, true', function () {
            expect(isValidExtendedManifest(ranged([
                { index: 0, range: '0-999' },
                { index: 0, range: '0-499', quality: 'alt' },
                { index: 0, range: '500-999', quality: 'alt', buffer: true }
            ]))).to.be.true; // jshint ignore:line
        });

        it('init cycle ranges with a gap, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{ range: '0-99' }, { range: '200-855', buffer: true }], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('init cycle ranges that tile, true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{ range: '0-99' }, { range: '100-855', buffer: true }], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('data cycle with range start > end, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, range: '500-100', buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('data cycle with an omitted range start, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, range: '-43999', buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('data cycle with an omitted range end, true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, range: '44000-', buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        // '' and 0 are malformed ranges, not absent ones.
        it('data cycle with an empty range, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, range: '', buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('init cycle with an empty range, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{ range: '' }], data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('data cycle with a zero range, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, range: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        // An absent range means "fetch the whole segment", which covers every
        // byte, so it legitimately excuses the group from the check.
        it('data cycle with an absent range is still unranged, true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, range: null, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('an empty range does not switch off the contiguity check', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{
                    label: 'a', init: [{}], data: [
                        { index: 0, range: '0-9' },
                        { index: 0, range: '' },
                        { index: 0, range: '50-99', buffer: true }
                    ]
                }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('the rejection names the suffix range semantics', function () {
            const logged = [];
            isValidExtendedManifest({
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, range: '-4', buffer: true }] }]
            }, { error: (m) => logged.push(m), warn: () => {} });
            const msg = logged.join(' ');
            expect(msg).to.include('suffix');
            expect(msg).to.include('"-4"');
        });

        it('data cycle with valid range, true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, range: '0-999', buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('data cycle with padding = true, true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, buffer: true }, { index: 0, padding: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('data cycle with padding = false, true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, padding: false, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('data cycle with padding string "true", true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, buffer: true }, { index: 0, padding: 'true' }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('data cycle with padding string "false", true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, padding: 'false', buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('data cycle with non-boolean padding, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, padding: 1, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('data cycle with non-parseable string padding, false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, padding: 'yes', buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('data cycle with quality = string (representation id), true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, quality: 'video_500k', buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('data cycle with quality = 0 (non-negative integer), true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, quality: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('data cycle with quality = 2 (positive integer), true', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, quality: 2, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('data cycle with quality = "3" (numeric string), true and kept as string (treated as representation ID), warning emitted', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, quality: '3', buffer: true }] }]
            };
            const warnings = [];
            const logger = { warn: (msg) => warnings.push(msg), info: () => {}, debug: () => {}, error: () => {} };
            expect(isValidExtendedManifest(m, logger)).to.be.true; // jshint ignore:line
            // Numeric strings are NOT normalized to numbers - use a JSON number if an index is intended.
            expect(m.streams[0].data[0].quality).to.equal('3');
            // A warning should be emitted to flag the ambiguity.
            const matched = warnings.filter((w) => w.indexOf('quality override resolves to an integer') !== -1);
            expect(matched.length).to.equal(1);
            expect(matched[0]).to.include('3');
            expect(matched[0]).to.include('treating as a representation ID');
        });

        it('data cycle with quality = -1 (negative integer), false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, quality: -1, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('data cycle with quality = 1.5 (non-integer number), false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, quality: 1.5, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('data cycle with quality = "" (empty string), false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, quality: '', buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('data cycle with quality = true (boolean), false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, quality: true, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('data cycle with quality = [] (array), false', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: [{}], data: [{ index: 0, quality: [], buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('valid manifest, true', function () {
            expect(isValidExtendedManifest(makeValidManifest())).to.be.true; // jshint ignore:line
        });

        it('sets stream.maxNoPad to the last non-padding cycle index', function () {
            // data has 3 non-padding cycles (0, 1, 2), maxNoPad should be 2
            const m = makeValidManifest();
            isValidExtendedManifest(m);
            expect(m.streams[0].maxNoPad).to.equal(2);
        });

        it('sets stream.maxNoPad excluding trailing padding cycles', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{
                    label: 'a',
                    init: [{}],
                    data: [
                        { index: 0, buffer: true }, // cycle 0, non-padding, maxNoPad = 0
                        { index: 1, buffer: true }, // cycle 1, non-padding, maxNoPad = 1
                        { index: 2, padding: true }, // cycle 2, padding, maxNoPad stays 1
                    ]
                }]
            };
            isValidExtendedManifest(m);
            expect(m.streams[0].maxNoPad).to.equal(1);
        });

        it('precomputes cycle.full: last non-padding occurrence of each index is full', function () {
            const m = makeValidManifest();
            // data: [{index:0}, {index:0, buffer:true}, {index:1, buffer:true}]
            isValidExtendedManifest(m);
            const data = m.streams[0].data;
            expect(data[0].full).to.be.false; // index 0, not last occurrence
            expect(data[1].full).to.be.true; // index 0, last occurrence
            expect(data[2].full).to.be.true; // index 1, last occurrence
        });

        it('precomputes cycle.full correctly with interleaved indices', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{
                    label: 'a',
                    init: [{}],
                    data: [
                        { index: 0, range: '0-100' }, // cycle 0: partial seg 0
                        { index: 1, range: '0-200' }, // cycle 1: partial seg 1
                        { index: 0, range: '100-200', buffer: [0, 1] }, // cycle 2: completes seg 0
                    ]
                }]
            };
            isValidExtendedManifest(m);
            const data = m.streams[0].data;
            expect(data[0].full).to.be.false; // index 0, but cycle 2 also has index 0
            expect(data[1].full).to.be.true; // index 1, last occurrence
            expect(data[2].full).to.be.true; // index 0, last occurrence
        });

        it('precomputes cycle.full: buffer = true forces full even when same index appears later', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{
                    label: 'a',
                    init: [{}],
                    data: [
                        { index: 0 }, // cycle 0: partial
                        { index: 0, buffer: true }, // cycle 1: buffer forces full
                        { index: 0 }, // cycle 2: partial (repeat)
                        { index: 0, buffer: true }, // cycle 3: buffer forces full
                    ]
                }]
            };
            isValidExtendedManifest(m);
            const data = m.streams[0].data;
            expect(data[0].full).to.be.false;
            expect(data[1].full).to.be.true;
            expect(data[2].full).to.be.false;
            expect(data[3].full).to.be.true;
        });

        it('precomputes cycle.full: selective buffer array forces full even when same index appears later', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{
                    label: 'a',
                    init: [{}],
                    data: [
                        { index: 0 }, // cycle 0: partial
                        { index: 0, buffer: [0] }, // cycle 1: selective buffer forces full
                        { index: 0 }, // cycle 2: partial
                        { index: 0, buffer: true }, // cycle 3: buffer forces full
                    ]
                }]
            };
            isValidExtendedManifest(m);
            const data = m.streams[0].data;
            expect(data[0].full).to.be.false;
            expect(data[1].full).to.be.true;
            expect(data[2].full).to.be.false;
            expect(data[3].full).to.be.true;
        });

        it('precomputes cycle.full: multiple buffer windows each get independent full marks', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{
                    label: 'a',
                    init: [{}],
                    data: [
                        { index: 0 }, // cycle 0: partial
                        { index: 1 }, // cycle 1: partial
                        { index: 0, buffer: true }, // cycle 2: flush all (window 1)
                        { index: 0 }, // cycle 3: partial (window 2)
                        { index: 1 }, // cycle 4: partial
                        { index: 1, buffer: true }, // cycle 5: flush all (window 2)
                    ]
                }]
            };
            isValidExtendedManifest(m);
            const data = m.streams[0].data;
            expect(data[0].full).to.be.false; // partial in window 1
            expect(data[1].full).to.be.true; // last index 1 before buffer at cycle 2
            expect(data[2].full).to.be.true; // buffer point, last index 0 in window 1
            expect(data[3].full).to.be.true; // last index 0 before buffer at cycle 5
            expect(data[4].full).to.be.false; // partial in window 2
            expect(data[5].full).to.be.true; // buffer point, last index 1 in window 2
        });

        it('precomputes cycle.full: selective buffer only marks target indices, remainder marked at next flush', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{
                    label: 'a',
                    init: [{}],
                    data: [
                        { index: 0 }, // cycle 0
                        { index: 1 }, // cycle 1
                        { index: 2, buffer: [0] }, // cycle 2: flush only index 0
                        { index: 1, buffer: true }, // cycle 3: flush remaining (1, 2)
                    ]
                }]
            };
            isValidExtendedManifest(m);
            const data = m.streams[0].data;
            expect(data[0].full).to.be.true; // last index 0 before selective flush at cycle 2
            expect(data[1].full).to.be.false; // index 1 not in [0], stays partial
            expect(data[2].full).to.be.true; // last index 2 before flush at cycle 3
            expect(data[3].full).to.be.true; // last index 1 before flush at cycle 3
        });

        it('precomputes cycle.full: empty buffer array does not force full', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{
                    label: 'a',
                    init: [{}],
                    data: [
                        { index: 0, buffer: [] }, // cycle 0: empty array = not active
                        { index: 0, buffer: true }, // cycle 1: last occurrence, full
                    ]
                }]
            };
            isValidExtendedManifest(m);
            const data = m.streams[0].data;
            expect(data[0].full).to.be.false;
            expect(data[1].full).to.be.true;
        });

        it('precomputes cycle.full: padding cycles are never full', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{
                    label: 'a',
                    init: [{}],
                    data: [
                        { index: 0, buffer: true },
                        { index: 1, padding: true },
                        { index: 2, padding: true },
                    ]
                }]
            };
            isValidExtendedManifest(m);
            const data = m.streams[0].data;
            expect(data[0].full).to.be.true;
            expect(data[1].full).to.be.false;
            expect(data[2].full).to.be.false;
        });
    });

    describe('init cycle quality validation and explicit buffer requirement', function () {
        it('rejects init cycle with empty string quality', function () {
            const m = { start: { mpd: '<MPD/>', base_uri: 'https://x.com/' }, streams: [{ label: 'a', init: [{ quality: '' }], data: [{ index: 0, buffer: true }] }] };
            expect(isValidExtendedManifest(m)).to.be.false;
        });

        it('rejects init cycle with negative integer quality', function () {
            const m = { start: { mpd: '<MPD/>', base_uri: 'https://x.com/' }, streams: [{ label: 'a', init: [{ quality: -1 }], data: [{ index: 0, buffer: true }] }] };
            expect(isValidExtendedManifest(m)).to.be.false;
        });

        it('rejects init cycle with non-integer number quality', function () {
            const m = { start: { mpd: '<MPD/>', base_uri: 'https://x.com/' }, streams: [{ label: 'a', init: [{ quality: 1.5 }], data: [{ index: 0, buffer: true }] }] };
            expect(isValidExtendedManifest(m)).to.be.false;
        });

        it('rejects init cycle with non-string, non-number quality', function () {
            const m = { start: { mpd: '<MPD/>', base_uri: 'https://x.com/' }, streams: [{ label: 'a', init: [{ quality: true }], data: [{ index: 0, buffer: true }] }] };
            expect(isValidExtendedManifest(m)).to.be.false;
        });

        it('accepts init cycle with valid string quality (with explicit buffer flags)', function () {
            const m = { start: { mpd: '<MPD/>', base_uri: 'https://x.com/' }, streams: [{ label: 'a', init: [{ buffer: true }, { quality: 'alt', buffer: true }], data: [{ index: 0, buffer: true }] }] };
            expect(isValidExtendedManifest(m)).to.be.true;
        });

        it('accepts init cycle with valid numeric quality (with explicit buffer flags)', function () {
            const m = { start: { mpd: '<MPD/>', base_uri: 'https://x.com/' }, streams: [{ label: 'a', init: [{ buffer: true }, { quality: 2, buffer: true }], data: [{ index: 0, buffer: true }] }] };
            expect(isValidExtendedManifest(m)).to.be.true;
        });

        it('multi-representation init without buffer flags: no default (designer-owned)', function () {
            const m = { start: { mpd: '<MPD/>', base_uri: 'https://x.com/' }, streams: [{ label: 'a', init: [{}, { quality: 'alt' }], data: [{ index: 0, buffer: true }] }] };
            expect(isValidExtendedManifest(m)).to.be.true;
            expect(m.streams[0].init[0].buffer).to.be.undefined;
            expect(m.streams[0].init[1].buffer).to.be.undefined;
        });

        it('single primary init group without buffer: defaults buffer: true on last cycle', function () {
            const m = { start: { mpd: '<MPD/>', base_uri: 'https://x.com/' }, streams: [{ label: 'a', init: [{ range: '0-99' }, { range: '100-199' }], data: [{ index: 0, buffer: true }] }] };
            expect(isValidExtendedManifest(m)).to.be.true;
            expect(m.streams[0].init[0].buffer).to.be.undefined;
            expect(m.streams[0].init[1].buffer).to.be.true;
            expect(m.streams[0].init[0].full).to.be.false;
            expect(m.streams[0].init[1].full).to.be.true;
        });

        it('explicit multi-representation init: each buffer-flagged cycle is full', function () {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{
                    label: 'home',
                    init: [
                        { range: '0-100' },
                        { range: '100-200', buffer: true },
                        { quality: 'alt_a', buffer: true },
                        { quality: 'alt_b', buffer: true }
                    ],
                    data: [{ index: 0, buffer: true }]
                }]
            };
            expect(isValidExtendedManifest(m)).to.be.true;
            const init = m.streams[0].init;
            expect(init[0].full).to.be.false;
            expect(init[1].full).to.be.true;
            expect(init[2].full).to.be.true;
            expect(init[3].full).to.be.true;
            expect(init.length).to.equal(4);
        });
    });

    describe('init cycle full computation with padding cycles', function () {

        function init(cycles) {
            const m = {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', init: cycles, data: [{ index: 0, buffer: true }] }]
            };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
            return m.streams[0].init;
        }

        // Padding responses are never accumulated, so a padding cycle carrying
        // `full` assembles the earlier real pieces of its own quality group and
        // releases them after the padding. That is the intended shape and must
        // keep working.

        it('a trailing padding cycle carries full for its group', function () {
            const cycles = init([{ range: '0-99' }, { padding: true }]);
            expect(cycles[0].full).to.be.false; // jshint ignore:line
            expect(cycles[1].full).to.be.true; // jshint ignore:line
            expect(cycles[1].buffer).to.be.true; // jshint ignore:line
        });

        it('only the last of several trailing padding cycles is full', function () {
            const cycles = init([{ range: '0-99' }, { padding: true }, { padding: true }]);
            expect(cycles.map(c => c.full)).to.deep.equal([false, false, true]);
        });

        it('each quality group ends at its own last cycle', function () {
            const cycles = init([{ range: '0-99', quality: 'v1' }, { range: '100-199' }, { padding: true }]);
            expect(cycles.map(c => c.full)).to.deep.equal([true, false, true]);
        });

        // A group with nothing but padding has no pieces to assemble. Marking
        // one of its cycles `full` runs the assembler over an empty match set,
        // which computes a negative size and throws inside the
        // FRAGMENT_LOADING_COMPLETED handler.

        it('an all-padding init list marks no cycle full', function () {
            const cycles = init([{ padding: true }]);
            expect(cycles[0].full).to.be.false; // jshint ignore:line
        });

        it('a home padding cycle is not full when only an override cycle is real', function () {
            const cycles = init([{ range: '0-99', quality: 'v1' }, { padding: true }]);
            expect(cycles[0].full).to.be.true; // jshint ignore:line
            expect(cycles[1].full).to.be.false; // jshint ignore:line
        });

        // A padding request shaped like an override init fetch is legitimate,
        // so it stays accepted; it is simply padding, not an assembly point.
        it('an override padding cycle with no real cycle of its own is not full', function () {
            const cycles = init([{ range: '0-99' }, { quality: 'v1', padding: true }]);
            expect(cycles[0].full).to.be.true; // jshint ignore:line
            expect(cycles[1].full).to.be.false; // jshint ignore:line
        });

        it('the same holds for a numeric quality key', function () {
            const cycles = init([{ range: '0-99' }, { quality: 2, padding: true }]);
            expect(cycles[0].full).to.be.true; // jshint ignore:line
            expect(cycles[1].full).to.be.false; // jshint ignore:line
        });

        it('a padding cycle that is not full still keeps its default buffer flag', function () {
            const cycles = init([{ padding: true }]);
            expect(cycles[0].buffer).to.be.true; // jshint ignore:line
            expect(cycles[0].full).to.be.false; // jshint ignore:line
        });
    });

    describe('progressive flag validation', function () {
        function progressiveManifest(data) {
            return {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [{ label: 'a', progressive: true, init: [{ range: '0-99' }], data }]
            };
        }

        it('stream with progressive = true, true', function () {
            expect(isValidExtendedManifest(progressiveManifest([{ index: 0, buffer: true }]))).to.be.true; // jshint ignore:line
        });

        it('stream with progressive = false, true', function () {
            const m = { start: { mpd: '<MPD/>', base_uri: 'https://x.com/' }, streams: [{ label: 'a', progressive: false, init: [{}], data: [{ index: 0, buffer: true }] }] };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });

        it('stream with progressive string "true", coerced to boolean, true', function () {
            const m = { start: { mpd: '<MPD/>', base_uri: 'https://x.com/' }, streams: [{ label: 'a', progressive: 'true', init: [{}], data: [{ index: 0, buffer: true }] }] };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
            expect(m.streams[0].progressive).to.equal(true);
        });

        it('stream with progressive string "false", coerced to boolean, true', function () {
            const m = { start: { mpd: '<MPD/>', base_uri: 'https://x.com/' }, streams: [{ label: 'a', progressive: 'false', init: [{}], data: [{ index: 0, buffer: true }] }] };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
            expect(m.streams[0].progressive).to.equal(false);
        });

        it('stream with non-boolean progressive (number), false', function () {
            const m = { start: { mpd: '<MPD/>', base_uri: 'https://x.com/' }, streams: [{ label: 'a', progressive: 1, init: [{}], data: [{ index: 0, buffer: true }] }] };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('stream with non-parseable string progressive, false', function () {
            const m = { start: { mpd: '<MPD/>', base_uri: 'https://x.com/' }, streams: [{ label: 'a', progressive: 'yes', init: [{}], data: [{ index: 0, buffer: true }] }] };
            expect(isValidExtendedManifest(m)).to.be.false; // jshint ignore:line
        });

        it('progressive stream with self-contained data (all introduced indices flushed), true', function () {
            expect(isValidExtendedManifest(progressiveManifest([{ index: 0 }, { index: 1, buffer: true }]))).to.be.true; // jshint ignore:line
        });

        it('progressive stream leaving an introduced index unflushed, false', function () {
            // A progressive seed must flush every index it introduces; index 0 is never buffered.
            expect(isValidExtendedManifest(progressiveManifest([{ index: 0 }]))).to.be.false; // jshint ignore:line
        });

        it('progressive stream with empty data (init-only seed), true', function () {
            expect(isValidExtendedManifest(progressiveManifest([]))).to.be.true; // jshint ignore:line
        });

        it('non-progressive counterpart of the same unflushed data is valid (implicit end-of-stream flush)', function () {
            const m = { start: { mpd: '<MPD/>', base_uri: 'https://x.com/' }, streams: [{ label: 'a', init: [{}], data: [{ index: 0 }] }] };
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
        });
    });

    // base_uri validation

    describe('base_uri validation', function () {

        function withBaseUri(baseUri) {
            return {
                start: { mpd: '<MPD/>', base_uri: baseUri },
                streams: [{ label: 'a', init: [{ range: '0-9' }], data: [{ index: 0, buffer: true }] }]
            };
        }

        function messages(baseUri) {
            const logged = [];
            isValidExtendedManifest(withBaseUri(baseUri), { error: (m) => logged.push(m), warn: () => {} });
            return logged;
        }

        // base_uri feeds two consumers with different failure modes.
        // urlUtils.parseBaseUrl() truncates it at the last slash to produce
        // manifest.baseUri, against which every segment resolves, and it is
        // concatenated raw into `${base_uri}static.mpd` for manifest.url, which
        // ExtUrlQueryInfoController hands to `new URL()` on every playback.

        describe('rejected', function () {
            const rejected = [
                ['empty string', ''],
                ['a bare word', 'x'],
                ['a phrase that is not a URL', 'not a url'],
                // parseBaseUrl drops everything after the last slash, so this
                // silently becomes 'https://cdn.example.com/' and every segment
                // resolves one directory too high.
                ['no trailing slash', 'https://cdn.example.com/vid'],
                // ManifestLoader resolves a relative MPD URL against
                // window.location before parseBaseUrl, but the Dodge path skips
                // that, so a relative base URI never becomes absolute.
                ['path absolute, no scheme or host', '/dodge/vid/'],
                ['scheme relative', '//cdn.example.com/vid/'],
                ['a non-HTTP scheme', 'ftp://cdn.example.com/vid/']
            ];

            rejected.forEach(function (entry) {
                it(entry[0] + ' is rejected', function () {
                    expect(isValidExtendedManifest(withBaseUri(entry[1]))).to.be.false; // jshint ignore:line
                });
            });

            it('a non-string is still rejected', function () {
                expect(isValidExtendedManifest(withBaseUri(123))).to.be.false; // jshint ignore:line
            });
        });

        describe('accepted', function () {
            const accepted = [
                ['https with a path', 'https://cdn.example.com/vid/'],
                ['https at the root', 'https://cdn.example.com/'],
                ['plain http', 'http://cdn.example.com/'],
                ['a port', 'https://cdn.example.com:8443/vid/'],
                // A signed CDN base carries its token in the query. new URL()
                // keeps it, and the concatenation puts static.mpd before it, so
                // manifest.url stays parseable.
                ['a query string', 'https://cdn.example.com/vid/?token=abc']
            ];

            accepted.forEach(function (entry) {
                it(entry[0] + ' is accepted', function () {
                    expect(isValidExtendedManifest(withBaseUri(entry[1]))).to.be.true; // jshint ignore:line
                });
            });
        });

        describe('diagnostics', function () {
            it('a missing trailing slash says so, and does not blame the URL syntax', function () {
                const msg = messages('https://cdn.example.com/vid').join(' ');
                expect(msg).to.include('base URI');
                expect(msg).to.include('/');
                expect(msg.toLowerCase()).to.not.include('absolute');
            });

            it('a relative value is reported as not absolute', function () {
                const msg = messages('/dodge/vid/').join(' ');
                expect(msg.toLowerCase()).to.include('absolute');
            });

            it('the offending value is quoted', function () {
                expect(messages('not a url').join(' ')).to.include('"not a url"');
            });
        });
    });

    // data cycle index normalization

    describe('data cycle index normalization', function () {

        function manifest(data, extra) {
            return {
                start: { mpd: '<MPD/>', base_uri: 'https://x.com/' },
                streams: [Object.assign({ label: 'a', init: [{ range: '0-9' }], data: data }, extra || {})]
            };
        }

        it('a string index is stored as a number', function () {
            const m = manifest([{ index: '0', buffer: true }]);
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
            expect(m.streams[0].data[0].index).to.equal(0);
        });
        
        it('a string index with a selective buffer array is accepted', function () {
            const m = manifest([
                { index: '0' },
                { index: '1', buffer: [0, 1] }
            ]);
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
            expect(m.streams[0].data.map(c => c.index)).to.deep.equal([0, 1]);
        });

        it('full flags with string indices match the numeric equivalent', function () {
            const cycles = [{ index: 0 }, { index: 0 }, { index: 1, buffer: true }];
            const strings = [{ index: '0' }, { index: '0' }, { index: '1', buffer: true }];

            const numeric = manifest(cycles);
            const stringy = manifest(strings);
            expect(isValidExtendedManifest(numeric)).to.be.true; // jshint ignore:line
            expect(isValidExtendedManifest(stringy)).to.be.true; // jshint ignore:line

            expect(stringy.streams[0].data.map(c => c.full))
                .to.deep.equal(numeric.streams[0].data.map(c => c.full));
            expect(stringy.streams[0].maxNoPad).to.equal(numeric.streams[0].maxNoPad);
        });

        it('getCycleIndexBySegmentIndex finds a cycle authored with a string index', function () {
            const m = manifest([{ index: '3', buffer: true }]);
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
            expect(getCycleIndexBySegmentIndex(m.streams[0], 3)).to.equal(0);
        });

        // The other two call sites of checkDataCycleFields are the progressive
        // runtime paths, which validate clones before pushing them.
        describe('progressive runtime paths', function () {
            let context, registry;

            beforeEach(function () {
                context = {};
                Debug(context).getInstance();
                registry = DefenseRegistry(context).getInstance();
                registry.reset();
                registry.addExtendedManifest(
                    manifest([{ index: 0, buffer: true }], { progressive: true }));
            });

            it('appendDataCycles normalizes a string index', function () {
                expect(registry.appendDataCycles('a', null, [{ index: '1', buffer: true }])).to.be.true; // jshint ignore:line
                const stream = registry.getDefendedStreamInfo('a');
                expect(stream.data[1].index).to.equal(1);
            });

            it('finalizeStream normalizes a string index on a trailing padding cycle', function () {
                expect(registry.finalizeStream('a', null, [{ index: '0', padding: true }])).to.be.true; // jshint ignore:line
                const stream = registry.getDefendedStreamInfo('a');
                expect(stream.data[1].index).to.equal(0);
            });
        });

        // Regression pins.

        it('a numeric index is unchanged', function () {
            const m = manifest([{ index: 4, buffer: true }]);
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
            expect(m.streams[0].data[0].index).to.equal(4);
        });

        it('a non-numeric string index is still rejected', function () {
            expect(isValidExtendedManifest(manifest([{ index: 'abc', buffer: true }]))).to.be.false; // jshint ignore:line
        });

        it('a fractional index is still rejected', function () {
            expect(isValidExtendedManifest(manifest([{ index: 1.5, buffer: true }]))).to.be.false; // jshint ignore:line
        });

        it('a negative index is still rejected', function () {
            expect(isValidExtendedManifest(manifest([{ index: -1, buffer: true }]))).to.be.false; // jshint ignore:line
        });

        // quality is deliberately NOT normalized: a numeric string there is a
        // representation ID, and coercing it would turn it into an array index.
        it('a numeric-string quality is still stored as a string', function () {
            const m = manifest([{ index: '0', quality: '2', buffer: true }]);
            expect(isValidExtendedManifest(m)).to.be.true; // jshint ignore:line
            expect(m.streams[0].data[0].index).to.equal(0);
            expect(m.streams[0].data[0].quality).to.equal('2');
        });
    });

    // getCycleIndexBySegmentIndex

    describe('getCycleIndexBySegmentIndex', function () {
        let stream;

        beforeEach(function () {
            // data: [{index: 0}, {index: 0, buffer}, {index: 1, buffer}]
            stream = makeValidManifest().streams[0];
        });

        it('returns the first cycle index for segment 0', function () {
            expect(getCycleIndexBySegmentIndex(stream, 0)).to.equal(0);
        });

        it('returns the first cycle index for segment 1 (skipping earlier cycles for segment 0)', function () {
            // cycles 0 and 1 have index = 0, cycle 2 has index = 1
            expect(getCycleIndexBySegmentIndex(stream, 1)).to.equal(2);
        });

        it('returns -1 when segment index is not in the stream', function () {
            expect(getCycleIndexBySegmentIndex(stream, 99)).to.equal(-1);
        });

        it('skips padding cycles when searching by index', function () {
            const s = {
                data: [
                    { index: 0, padding: true }, // cycle 0, padding, must be skipped
                    { index: 0, buffer: true }, // cycle 1, non-padding, should match
                ]
            };
            expect(getCycleIndexBySegmentIndex(s, 0)).to.equal(1);
        });
    });

    // DefenseRegistry instance

    describe('instance', function () {
        let context, registry;

        beforeEach(function () {
            context = {};
            Debug(context).getInstance();
            registry = DefenseRegistry(context).getInstance();
            registry.reset();
        });

        it('addExtendedManifest with a valid manifest, returns true', function () {
            expect(registry.addExtendedManifest(makeValidManifest())).to.be.true; // jshint ignore:line
        });

        it('addExtendedManifest with null, returns false', function () {
            expect(registry.addExtendedManifest(null)).to.be.false; // jshint ignore:line
        });

        it('getDefendedStreamInfo finds a registered stream by label', function () {
            registry.addExtendedManifest(makeValidManifest());
            const info = registry.getDefendedStreamInfo('video_1000k');
            expect(info).to.exist; // jshint ignore:line
            expect(info.label).to.equal('video_1000k');
        });

        it('getDefendedStreamInfo returns null for an unknown label', function () {
            registry.addExtendedManifest(makeValidManifest());
            expect(registry.getDefendedStreamInfo('unknown')).to.be.null; // jshint ignore:line
        });

        it('reset clears all manifests, getDefendedStreamInfo returns null after reset', function () {
            registry.addExtendedManifest(makeValidManifest());
            registry.reset();
            expect(registry.getDefendedStreamInfo('video_1000k')).to.be.null; // jshint ignore:line
        });

        it('getDefendedStreamInfo with periodIndex, matches stream with matching period field', function () {
            registry.addExtendedManifest({
                start: { mpd: '<MPD/>', base_uri: 'https://example.com/' },
                streams: [
                    { label: 'video_1000k', period: 0, init: [{}], data: [{ index: 0, buffer: true }] },
                    { label: 'video_1000k', period: 1, init: [{}], data: [{ index: 5, buffer: true }] },
                ]
            });
            const p0 = registry.getDefendedStreamInfo('video_1000k', 0);
            expect(p0).to.exist; // jshint ignore:line
            expect(p0.data[0].index).to.equal(0);
            const p1 = registry.getDefendedStreamInfo('video_1000k', 1);
            expect(p1).to.exist; // jshint ignore:line
            expect(p1.data[0].index).to.equal(5);
        });

        it('getDefendedStreamInfo with periodIndex, returns null when no period matches', function () {
            registry.addExtendedManifest({
                start: { mpd: '<MPD/>', base_uri: 'https://example.com/' },
                streams: [
                    { label: 'video_1000k', period: 0, init: [{}], data: [{ index: 0, buffer: true }] },
                ]
            });
            expect(registry.getDefendedStreamInfo('video_1000k', 99)).to.be.null; // jshint ignore:line
        });

        it('getDefendedStreamInfo with periodIndex, stream without period field matches any period', function () {
            registry.addExtendedManifest(makeValidManifest());
            // makeValidManifest() has no period field on the stream.
            const p0 = registry.getDefendedStreamInfo('video_1000k', 0);
            expect(p0).to.exist; // jshint ignore:line
            const p5 = registry.getDefendedStreamInfo('video_1000k', 5);
            expect(p5).to.exist; // jshint ignore:line
        });

        it('getDefendedStreamInfo without periodIndex, matches stream with period field', function () {
            registry.addExtendedManifest({
                start: { mpd: '<MPD/>', base_uri: 'https://example.com/' },
                streams: [
                    { label: 'video_1000k', period: 0, init: [{}], data: [{ index: 0, buffer: true }] },
                ]
            });
            // No periodIndex passed: matches the first label match regardless of period.
            expect(registry.getDefendedStreamInfo('video_1000k')).to.exist; // jshint ignore:line
        });

        describe('progressive append and finalize', function () {
            function addProgressive(data) {
                registry.addExtendedManifest({
                    start: { mpd: '<MPD/>', base_uri: 'https://example.com/' },
                    streams: [{ label: 'video_1000k', progressive: true, init: [{ range: '0-99' }], data }]
                });
            }

            it('appendDataCycles returns false when no stream matches the label', function () {
                addProgressive([{ index: 0, buffer: true }]);
                expect(registry.appendDataCycles('nope', null, [{ index: 1, buffer: true }])).to.be.false; // jshint ignore:line
            });

            it('appendDataCycles returns false when the stream is not progressive', function () {
                registry.addExtendedManifest(makeValidManifest()); // no progressive flag
                expect(registry.appendDataCycles('video_1000k', null, [{ index: 3, buffer: true }])).to.be.false; // jshint ignore:line
            });

            it('appendDataCycles returns false for an empty batch', function () {
                addProgressive([{ index: 0, buffer: true }]);
                expect(registry.appendDataCycles('video_1000k', null, [])).to.be.false; // jshint ignore:line
            });

            it('appendDataCycles appends a self-contained batch and returns true', function () {
                addProgressive([{ index: 0, buffer: true }]);
                const before = registry.getDefendedStreamInfo('video_1000k').data.length;
                expect(registry.appendDataCycles('video_1000k', null, [{ index: 1, buffer: true }])).to.be.true; // jshint ignore:line
                expect(registry.getDefendedStreamInfo('video_1000k').data.length).to.equal(before + 1);
            });

            it('appendDataCycles makes new cycles visible via the live stream reference', function () {
                addProgressive([{ index: 0, buffer: true }]);
                const ref = registry.getDefendedStreamInfo('video_1000k'); // captured before append
                registry.appendDataCycles('video_1000k', null, [{ index: 1, buffer: true }]);
                expect(ref.data[ref.data.length - 1].index).to.equal(1);
            });

            it('appendDataCycles computes full flags over the batch alone', function () {
                addProgressive([{ index: 0, buffer: true }]);
                registry.appendDataCycles('video_1000k', null, [{ index: 1 }, { index: 1, buffer: true }]);
                const data = registry.getDefendedStreamInfo('video_1000k').data;
                // batch [ {1}, {1, buffer} ]: first occurrence not full, last occurrence full
                expect(data[1].full).to.be.false; // jshint ignore:line
                expect(data[2].full).to.be.true; // jshint ignore:line
            });

            it('appendDataCycles updates maxNoPad', function () {
                addProgressive([{ index: 0, buffer: true }]);
                registry.appendDataCycles('video_1000k', null, [{ index: 1, buffer: true }]);
                expect(registry.getDefendedStreamInfo('video_1000k').maxNoPad).to.equal(1);
            });

            it('appendDataCycles rejects a batch that leaves an introduced index unflushed, changing nothing', function () {
                addProgressive([{ index: 0, buffer: true }]);
                const before = registry.getDefendedStreamInfo('video_1000k').data.length;
                expect(registry.appendDataCycles('video_1000k', null, [{ index: 1 }])).to.be.false; // jshint ignore:line
                expect(registry.getDefendedStreamInfo('video_1000k').data.length).to.equal(before);
            });

            it('appendDataCycles rejects a batch whose buffer array references an index outside the batch, changing nothing', function () {
                addProgressive([{ index: 0, buffer: true }]);
                const before = registry.getDefendedStreamInfo('video_1000k').data.length;
                // index 0 belongs to the frozen prefix, not this batch
                expect(registry.appendDataCycles('video_1000k', null, [{ index: 1, buffer: [0, 1] }])).to.be.false; // jshint ignore:line
                expect(registry.getDefendedStreamInfo('video_1000k').data.length).to.equal(before);
            });

            it('appendDataCycles rejects a structurally invalid batch, changing nothing', function () {
                addProgressive([{ index: 0, buffer: true }]);
                const before = registry.getDefendedStreamInfo('video_1000k').data.length;
                expect(registry.appendDataCycles('video_1000k', null, [{ index: -1, buffer: true }])).to.be.false; // jshint ignore:line
                expect(registry.getDefendedStreamInfo('video_1000k').data.length).to.equal(before);
            });

            it('appendDataCycles does not mutate the caller batch buffer array', function () {
                addProgressive([{ index: 0, buffer: true }]);
                const batch = [{ index: 1, buffer: ['1'] }]; // string element coerced internally
                registry.appendDataCycles('video_1000k', null, batch);
                expect(batch[0].buffer[0]).to.equal('1'); // original preserved (clone is coerced, not caller)
            });

            it('finalizeStream returns false when no stream matches the label', function () {
                addProgressive([{ index: 0, buffer: true }]);
                expect(registry.finalizeStream('nope', null)).to.be.false; // jshint ignore:line
            });

            it('finalizeStream clears the progressive flag and returns true', function () {
                addProgressive([{ index: 0, buffer: true }]);
                expect(registry.finalizeStream('video_1000k', null)).to.be.true; // jshint ignore:line
                expect(registry.getDefendedStreamInfo('video_1000k').progressive).to.be.false; // jshint ignore:line
            });

            it('finalizeStream appends trailing padding and excludes it from maxNoPad', function () {
                addProgressive([{ index: 0, buffer: true }]);
                expect(registry.finalizeStream('video_1000k', null, [{ index: 1, padding: true }])).to.be.true; // jshint ignore:line
                const s = registry.getDefendedStreamInfo('video_1000k');
                expect(s.data[s.data.length - 1].padding).to.be.true; // jshint ignore:line
                expect(s.maxNoPad).to.equal(0); // trailing padding excluded
            });

            it('finalizeStream rejects a non-padding trailing cycle, changing nothing', function () {
                addProgressive([{ index: 0, buffer: true }]);
                const before = registry.getDefendedStreamInfo('video_1000k').data.length;
                expect(registry.finalizeStream('video_1000k', null, [{ index: 1, buffer: true }])).to.be.false; // jshint ignore:line
                const s = registry.getDefendedStreamInfo('video_1000k');
                expect(s.data.length).to.equal(before);
                expect(s.progressive).to.be.true; // still progressive on failure
            });

            it('appendDataCycles returns false after finalizeStream', function () {
                addProgressive([{ index: 0, buffer: true }]);
                registry.finalizeStream('video_1000k', null);
                expect(registry.appendDataCycles('video_1000k', null, [{ index: 1, buffer: true }])).to.be.false; // jshint ignore:line
            });

            it('finalizeStream returns false on a second (double) finalize, changing nothing', function () {
                addProgressive([{ index: 0, buffer: true }]);
                expect(registry.finalizeStream('video_1000k', null, [{ index: 1, padding: true }])).to.be.true; // jshint ignore:line
                const before = registry.getDefendedStreamInfo('video_1000k').data.length;
                expect(registry.finalizeStream('video_1000k', null, [{ index: 2, padding: true }])).to.be.false; // jshint ignore:line
                const s = registry.getDefendedStreamInfo('video_1000k');
                expect(s.data.length).to.equal(before); // no extra padding appended
            });

            it('finalizeStream returns false for a non-progressive (complete) stream', function () {
                // A complete (non-progressive) manifest stream must not be finalizable.
                registry.addExtendedManifest(makeValidManifest()); // no progressive flag
                expect(registry.getDefendedStreamInfo('video_1000k').progressive).to.not.equal(true); // jshint ignore:line
                expect(registry.finalizeStream('video_1000k', null, [{ index: 1, padding: true }])).to.be.false; // jshint ignore:line
            });
        });
    });
});
