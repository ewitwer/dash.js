/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */

import { getDodgeDebug } from './utils/DodgeDebug.js';
import FactoryMaker from '../core/FactoryMaker.js';

/**
 * Group key for an init cycle's `full` computation. Cycles are grouped by the
 * representation they fetch from, so an override cycle terminates its own run
 * rather than the home representation's. Undefined and null both mean the home
 * representation, and the number/string prefixes keep quality `2` distinct from
 * quality `'2'`, which resolve differently.
 * @param {Object} cycle - The init cycle to key.
 * @returns {string} Group key.
 */
/**
 * True when a range string omits its start, e.g. "-855".
 *
 * Cycle ranges come from measured segment sizes, so an explicit start is
 * always available and nothing needs the suffix form.
 *
 * @param {string} range - The range string, already known to be a string.
 * @returns {boolean} True when the start bound is missing.
 */
function _omitsRangeStart(range) {
    return range.charAt(0) === '-';
}

function _initQualityKey(cycle) {
    if (cycle.quality === undefined || cycle.quality === null) {
        return 'home';
    }
    return (typeof cycle.quality === 'number' ? 'n:' : 's:') + cycle.quality;
}

/**
 * Byte bounds of a cycle range, or null when the cycle has no range and so
 * fetches the whole segment. Ranges reaching this point are already known to be
 * well formed; an omitted end runs to the end of the resource.
 *
 * @param {string|undefined|null} range - The cycle's range.
 * @returns {{start: number, end: number}|null} Bounds, or null for "everything".
 */
function _cycleRangeBounds(range) {
    if (range === undefined || range === null || range === '') {
        return null;
    }
    const tokens = String(range).split('-');
    const start = parseInt(tokens[0], 10);
    const end = parseInt(tokens[1], 10);

    return { start: isNaN(start) ? 0 : start, end: isNaN(end) ? Infinity : end };
}

/**
 * The first hole in a set of byte ranges, or null when they are contiguous.
 * Overlap is not a hole: pieces are written over each other and redundant
 * coverage is a legitimate defense lever.
 *
 * @param {Array<{start: number, end: number}>} ranges - Bounds to cover.
 * @returns {{from: number, to: number}|null} The first uncovered span.
 */
function _findRangeGap(ranges) {
    const sorted = ranges.slice().sort((a, b) => a.start - b.start);
    let covered = sorted[0].end;

    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].start > covered + 1) {
            return { from: covered + 1, to: sorted[i].start - 1 };
        }
        covered = Math.max(covered, sorted[i].end);
    }

    return null;
}

/**
 * Reject cycles whose ranges leave a hole in the segment they assemble.
 *
 * `DodgeHandler._concatPartialSegments` sizes the result from the lowest range
 * start to the highest range end and writes each piece at its own offset, so a
 * span no cycle covers is appended to the SourceBuffer as zeros.
 *
 * Grouping mirrors the assembler. Pieces are matched by segment index and by
 * representation, so cycles carrying a quality override form their own group and
 * cannot fill a hole left by the home representation's. Padding cycles are
 * excluded because their responses are never accumulated, so a padding range
 * cannot close a gap either. A group ends at its `full` cycle, which is where the
 * assembler runs and consumes the pieces; the same index fetched again afterwards
 * starts a new group.
 *
 * What this cannot check is whether the ranges cover the *whole* segment. Segment
 * sizes come from measurement, not from the MPD, so under-coverage at the end is
 * indistinguishable from a segment that is exactly that long.
 *
 * @param {Array} cycles - The init or data cycles, with `full` already computed.
 * @param {string} label - Stream label, for error messages.
 * @param {boolean} isInit - True for init cycles, which carry no segment index.
 * @param {Object} [logger] - Optional logger for rejection messages.
 * @returns {boolean} True when every group is contiguous.
 */
function checkRangeContiguity(cycles, label, isInit, logger) {
    const groups = new Map();

    function validate(group) {
        if (group.unranged || group.ranges.length < 2) {
            return true;
        }
        const gap = _findRangeGap(group.ranges);
        if (gap) {
            if (logger) {
                logger.error('Extended manifest rejected: defended stream info with label ' + label +
                    ', ' + group.description + ' leaves bytes ' + gap.from + '-' + gap.to +
                    ' uncovered, so the assembled segment would be zero-filled there');
            }
            return false;
        }
        return true;
    }

    for (let i = 0; i < cycles.length; i++) {
        const cycle = cycles[i];
        if (cycle.padding) {
            continue;
        }

        const qualityKey = _initQualityKey(cycle);
        const key = qualityKey + '|' + (isInit ? 'init' : cycle.index);

        let group = groups.get(key);
        if (!group) {
            group = {
                ranges: [],
                unranged: false,
                description: (isInit ? 'init cycles' : 'cycles for segment index ' + cycle.index) +
                    (qualityKey === 'home' ? '' : ' at quality ' + JSON.stringify(cycle.quality))
            };
            groups.set(key, group);
        }

        const bounds = _cycleRangeBounds(cycle.range);
        if (bounds) {
            group.ranges.push(bounds);
        } else {
            group.unranged = true;
        }

        if (cycle.full) {
            if (!validate(group)) {
                return false;
            }
            groups.delete(key);
        }
    }

    // A group with no `full` cycle is never assembled, but check it anyway so a
    // hole is reported wherever it sits.
    let contiguous = true;
    groups.forEach((group) => {
        if (contiguous && !validate(group)) {
            contiguous = false;
        }
    });

    return contiguous;
}

/**
 * Validate the fields an init cycle and a data cycle have in common: range,
 * padding, buffer, and quality. String booleans are normalized and buffer array
 * elements coerced in place, so a caller reads the resolved value afterwards.
 *
 * The two cycle kinds differ in one field. A selective buffer array names
 * segment indices, and an init cycle has none to name, so an array is rejected
 * there and tentatively accepted here.
 *
 * @param {string} label - Stream label, for error messages.
 * @param {Object} cycle - The cycle to validate (mutated in place).
 * @param {number} i - Cycle position, for error messages.
 * @param {boolean} isInit - True for init cycles, which take no buffer array.
 * @param {Object} [logger] - Optional logger for rejection messages.
 * @returns {boolean} True if the shared fields are valid.
 */
function checkSharedCycleFields(label, cycle, i, isInit, logger) {
    const where = 'defended stream info with label ' + label + ', ' +
        (isInit ? 'init' : 'data') + ' cycle at index ' + i + ', ';

    function reject(message) {
        if (logger) {
            logger.error('Extended manifest rejected: ' + where + message);
        }
        return false;
    }

    // range is optional but, when present, MUST be a string of the form
    // "<start>-<end>". The end MAY be omitted ("44-"), in which case it runs
    // to the end of the resource.
    const range = cycle.range;
    if (range !== undefined && range !== null) {
        if (typeof range !== 'string' && !(range instanceof String)) {
            return reject('invalid range');
        }

        if (_omitsRangeStart(range)) {
            return reject('range ' + JSON.stringify(range) +
                ' omits its start, which HTTP reads as a suffix range');
        }
        
        const rangeTokens = range.split('-');
        if (rangeTokens.length !== 2 || !/^\d+$/.test(rangeTokens[0]) || !/^\d*$/.test(rangeTokens[1])) {
            return reject('invalid range');
        }
        const rs = parseInt(rangeTokens[0], 10);
        // An omitted end runs to the end of the resource.
        const re = rangeTokens[1] === '' ? Number.MAX_SAFE_INTEGER : parseInt(rangeTokens[1], 10);

        // Range start MUST NOT exceed range end.
        if (rs > re) {
            return reject('invalid range');
        }
    }

    // padding MUST be a boolean (or a string parseable to boolean), or absent.
    let padding = cycle.padding;
    if (padding !== undefined && padding !== null) {
        if (typeof padding === 'string') {
            if (padding === 'true') {
                padding = true;
            } else if (padding === 'false') {
                padding = false;
            } else {
                return reject('invalid padding value');
            }
            cycle.padding = padding;
        } else if (typeof padding !== 'boolean') {
            return reject('invalid padding value');
        }
    }

    // buffer MUST be a boolean (or a string parseable to boolean), or absent.
    // On a data cycle it MAY also be an array of non-negative segment indices
    // (selective buffering).
    let buffer = cycle.buffer;
    if (buffer !== undefined && buffer !== null) {
        if (Array.isArray(buffer)) {
            if (isInit) {
                return reject('buffer must not be an array');
            }
            for (let j = 0; j < buffer.length; j++) {
                const elem = Number(buffer[j]);
                if (isNaN(elem) || elem < 0 || !Number.isInteger(elem)) {
                    return reject('invalid buffer array element at position ' + j);
                }
                buffer[j] = elem;
            }
            cycle.buffer = buffer;
        } else if (typeof buffer === 'string') {
            if (buffer === 'true') {
                buffer = true;
            } else if (buffer === 'false') {
                buffer = false;
            } else {
                return reject('invalid buffer value');
            }
            cycle.buffer = buffer;
        } else if (typeof buffer !== 'boolean') {
            return reject('invalid buffer value');
        }
    }

    // quality is optional. When present, it selects an alternate representation
    // in the same adaptation set to fetch this cycle from. Accepted forms: a
    // non-empty string (matched against representation.id at request time)
    // or a non-negative integer (index into the array returned by
    // adapter.getVoRepresentations(mediaInfo)).
    const quality = cycle.quality;
    if (quality !== undefined && quality !== null) {
        if (typeof quality === 'string') {
            if (quality.length === 0) {
                return reject('invalid quality override (empty string)');
            }
            // Since other fields can be strings as long as they resolve to
            // integers, warn here that strings containing numbers will be
            // interpreted as representation IDs (use a JSON number if an
            // index is intended).
            const qint = Number(quality);
            if (!isNaN(qint) && Number.isInteger(qint) && logger) {
                logger.warn('Extended manifest parsing: ' + where +
                    'quality override resolves to an integer ' + qint +
                    ', treating as a representation ID');
            }
        } else if (typeof quality === 'number') {
            if (!Number.isInteger(quality) || quality < 0) {
                return reject('invalid quality override (must be a non-negative integer)');
            }
        } else {
            return reject('invalid quality override');
        }
    }

    return true;
}

/**
 * Validate init cycles in a stream entry: the shared cycle fields (selective
 * buffering is not allowed here), then precompute `full` flags and check that
 * the ranges of each assembly group are contiguous.
 * @param {Object} stream - The stream entry from an extended manifest.
 * @param {Object} [logger] - Optional logger for rejection messages.
 * @returns {boolean} True if all init cycles are valid.
 */
function checkInitCycles(stream, logger) {
    for (let i = 0; i < stream['init'].length; i++) {
        if (!checkSharedCycleFields(stream['label'], stream['init'][i], i, true, logger)) {
            return false;
        }
    }

    // Precompute the `full` flag for each init cycle. A cycle is `full` when
    // it is the last cycle of a contiguous run for the same representation
    // (identified by its `quality` value - undefined/null is the home rep).
    // Mirrors the data cycle backward scan for segment indices. Defense
    // designers are responsible for setting `buffer: true` on cycles that
    // should fire INIT_FRAGMENT_LOADED (a subset of the `full` cycles).
    //
    // Simple default for the single representation case: if no cycle
    // carries a quality override and no cycle has `buffer: true`, set
    // `buffer: true` on the last init cycle. With multi-representation
    // defenses, the designer must set the buffer flag explicitly.
    const hasQuality = stream['init'].some(c => c.quality !== undefined && c.quality !== null);
    const hasBuffer = stream['init'].some(c => c.buffer === true);
    if (!hasQuality && !hasBuffer && stream['init'].length > 0) {
        stream['init'][stream['init'].length - 1].buffer = true;
    }

    // A cycle can only be `full` if there are pieces to assemble by the time it
    // arrives, and DodgeHandler never accumulates a padding response. A group
    // of nothing but padding therefore has nothing to assemble: marking one of
    // its cycles `full` runs the assembler over an empty match set, which
    // computes a negative size and throws. Its cycles are plain padding.
    const assemblable = new Set();
    for (let i = 0; i < stream['init'].length; i++) {
        if (!stream['init'][i].padding) {
            assemblable.add(_initQualityKey(stream['init'][i]));
        }
    }

    const seen = new Set();
    for (let i = stream['init'].length - 1; i >= 0; i--) {
        const cycle = stream['init'][i];
        const key = _initQualityKey(cycle);
        if (seen.has(key) || !assemblable.has(key)) {
            cycle.full = false;
        } else {
            cycle.full = true;
            seen.add(key);
        }
    }

    return checkRangeContiguity(stream['init'], stream['label'], true, logger);
}

/**
 * Validate a single data cycle: its segment index, then the fields it shares
 * with init cycles. Normalizes string booleans and coerces buffer array
 * elements in place. Does not validate buffer array references, which
 * need the whole cycle run.
 * @param {string} label - Stream label, for error messages.
 * @param {Object} cycle - The data cycle to validate (mutated in place).
 * @param {number} i - Cycle position, for error messages.
 * @param {Object} [logger] - Optional logger for rejection messages.
 * @returns {boolean} True if the cycle's fields are valid.
 */
function checkDataCycleFields(label, cycle, i, logger) {
    // Every data cycle MUST have a non-negative integer segment index.
    // Strings are accepted if they parse to a non-negative integer.
    const idx = Number(cycle.index);
    if (isNaN(idx) || idx < 0 || !Number.isInteger(idx)) {
        if (logger) {
            logger.error('Extended manifest rejected: defended stream info with label ' + label + ', data cycle at index ' + i + ', invalid index');
        }
        return false;
    }

    // Store the validated value.
    cycle.index = idx;

    return checkSharedCycleFields(label, cycle, i, false, logger);
}

/**
 * Return the index of the last non-padding cycle in an array, or -1.
 * @param {Array} data - The cycle array.
 * @returns {number}
 */
function computeMaxNoPad(data) {
    let maxNoPad = -1;
    for (let i = 0; i < data.length; i++) {
        if (!data[i].padding) {
            maxNoPad = i;
        }
    }
    return maxNoPad;
}

/**
 * How far back a scan for the given segment indices has to reach: the earliest
 * position among their cycles that no flush has consumed yet.
 *
 * @param {Map} pendingSince - Segment index to the position of its earliest
 *        unflushed cycle.
 * @param {Set} target - Segment indices being flushed.
 * @returns {number} Earliest position to scan, inclusive.
 */
function _earliestPending(pendingSince, target) {
    let earliest = Infinity;
    target.forEach((index) => {
        const since = pendingSince.get(index);
        if (since !== undefined && since < earliest) {
            earliest = since;
        }
    });
    return earliest === Infinity ? 0 : earliest;
}

/**
 * Mark the last cycle of every assembly group whose segment index is in
 * `target`, scanning backwards from position `to`.
 *
 * `DodgeHandler._concatPartialSegments` matches accumulated pieces by segment
 * index *and* by representation, so a cycle carrying a quality override belongs
 * to its own group and needs its own `full` cycle. Marking one cycle per index
 * instead leaves the other group's responses accumulated and never assembled,
 * where they stay for the life of the stream. Grouping here mirrors
 * `checkRangeContiguity` and `checkInitCycles`.
 *
 * @param {Array} data - The cycle array.
 * @param {number} from - Earliest position to scan, inclusive.
 * @param {number} to - Position to scan back from, inclusive.
 * @param {Set} target - Segment indices being flushed.
 */
function markAssemblyGroups(data, from, to, target) {
    const seen = new Set();

    for (let j = to; j >= from; j--) {
        const cycle = data[j];
        if (cycle.padding || !target.has(cycle.index)) {
            continue;
        }

        const key = _initQualityKey(cycle) + '|' + cycle.index;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        cycle.full = true;
    }
}

/**
 * Precompute the `full` flag for a contiguous run of data cycles (mutates each
 * cycle's `full`). `full` triggers segment assembly in
 * DodgeHandler._concatPartialSegments: at each buffer directive, every assembly
 * group that will be flushed must have exactly one cycle marked full (the last
 * download of that group before the flush point). We scan forward; when we hit
 * a buffer directive, markAssemblyGroups scans backwards over the cycles no
 * earlier flush consumed. A group is a segment index at one representation, so
 * an index fetched at more than one quality has a full cycle per quality. Also
 * validates that selective buffer arrays only reference indices that have
 * appeared (and not yet been flushed) within this run.
 *
 * Every non-padding index the run introduces MUST also be flushed within it.
 *
 * @param {Array} data - The cycle array (a whole stream or a single append batch).
 * @param {boolean} isProgressiveBatch - True for a progressive seed or an
 *        incremental append batch, which only changes how a leftover index is
 *        described in the rejection message.
 * @param {string} label - Stream label, for error messages.
 * @param {Object} [logger] - Optional logger for rejection messages.
 * @returns {boolean} True on success.
 */
function computeDataCycleFull(data, isProgressiveBatch, label, logger) {
    for (let i = 0; i < data.length; i++) {
        data[i].full = false;
    }

    const pendingIndices = new Set();
    // Segment index -> position of its earliest cycle not yet consumed by a
    // flush, which is how far back a scan for that index has to reach.
    const pendingSince = new Map();

    for (let i = 0; i < data.length; i++) {
        const cycle = data[i];
        cycle.full = false;

        if (!cycle.padding) {
            if (!pendingIndices.has(cycle.index)) {
                pendingSince.set(cycle.index, i);
            }
            pendingIndices.add(cycle.index);
        }

        const bufferActive = cycle.buffer === true
            || (Array.isArray(cycle.buffer) && cycle.buffer.length > 0);

        if (bufferActive) {
            let target;
            if (cycle.buffer === true) {
                target = new Set(pendingIndices);
            } else {
                target = new Set();
                for (let k = 0; k < cycle.buffer.length; k++) {
                    if (!pendingIndices.has(cycle.buffer[k])) {
                        if (logger) {
                            logger.error('Extended manifest rejected: defended stream info with label ' + label + ', data cycle at index ' + i + ', buffer array references segment index ' + cycle.buffer[k] + ' which has not appeared in the stream');
                        }
                        return false;
                    }
                    target.add(cycle.buffer[k]);
                }
            }

            markAssemblyGroups(data, _earliestPending(pendingSince, target), i, target);

            if (cycle.buffer === true) {
                pendingIndices.clear();
                pendingSince.clear();
            } else {
                for (let k = 0; k < cycle.buffer.length; k++) {
                    pendingIndices.delete(cycle.buffer[k]);
                    pendingSince.delete(cycle.buffer[k]);
                }
            }
        }
    }

    // Every index the run introduces MUST be flushed before the run ends.
    if (pendingIndices.size > 0) {
        if (logger) {
            logger.error('Extended manifest rejected: defended stream info with label ' + label + ', ' +
                (isProgressiveBatch ? 'progressive batch' : 'data cycles') + ' leave(s) segment index(es) ' +
                Array.from(pendingIndices).join(', ') + ' unbuffered; every segment index must be flushed ' +
                'by a buffer directive within the cycles that introduce it, and bytes that are not meant ' +
                'to be played belong in a padding cycle');
        }
        return false;
    }

    return true;
}

/**
 * Validate data cycles in a stream entry. Check that segment indices are
 * non-negative; ranges are well-formed; and the padding, buffer, and quality
 * fields have correct values. Set `stream.maxNoPad` to the index of the last
 * non-padding cycle and precompute `full` flags. When `stream.progressive` is
 * true, the data cycles must be self-contained (every segment index flushed
 * within them), since the stream will be extended at runtime.
 * @param {Object} stream - The stream entry from an extended manifest.
 * @param {Object} [logger] - Optional logger for rejection messages.
 * @returns {boolean} True if all data cycles are valid.
 */
function checkDataCycles(stream, logger) {
    const data = stream['data'];

    for (let i = 0; i < data.length; i++) {
        if (!checkDataCycleFields(stream['label'], data[i], i, logger)) {
            return false;
        }
    }

    stream.maxNoPad = computeMaxNoPad(data);

    if (!computeDataCycleFull(data, !!stream['progressive'], stream['label'], logger)) {
        return false;
    }

    return checkRangeContiguity(data, stream['label'], false, logger);
}

/**
 * Validate the structure of an extended manifest object. Check for `start.mpd`
 * and `start.base_uri` which should be strings, that `streams` is a non-empty
 * array of well-formed entries (with proper `label`, `period`, and init and/or
 * data cycles), and validate cycles with `checkInitCycles` and `checkDataCycles`.
 * The manifest is not allowed to be dynamic. Also set `stream.maxNoPad` on each
 * stream entry, a side effect of `checkDataCycles`, and precompute `full` flags
 * for both init and data cycles.
 * @param {Object} manifest - The parsed extended manifest JSON object.
 * @param {Object} [logger] - Optional logger for rejection messages.
 * @returns {boolean} True if the extended manifest is valid.
 */
function isValidExtendedManifest(manifest, logger) {
    if (!manifest) {
        if (logger) {
            logger.error('Extended manifest rejected: null');
        }
        return false;
    }

    // An extended manifest MUST contain the start object.
    if (!manifest['start']) {
        if (logger) {
            logger.error('Extended manifest rejected: no start data');
        }
        return false;
    }

    // An extended manifest MUST contain the video's original MPD.
    if (typeof manifest['start']['mpd'] !== 'string' && !(manifest['start']['mpd'] instanceof String)) {
        if (logger) {
            logger.error('Extended manifest rejected: incomplete start data, missing mpd');
        }
        return false;
    }

    // An extended manifest MUST contain a base URI for segments.
    const baseUri = manifest['start']['base_uri'];
    if (typeof baseUri !== 'string' && !(baseUri instanceof String)) {
        if (logger) {
            logger.error('Extended manifest rejected: incomplete start data, missing base URI');
        }
        return false;
    }

    // The base URI has to be absolute.
    let parsedBaseUri;
    try {
        parsedBaseUri = new URL(baseUri);
    } catch (e) {
        if (logger) {
            logger.error('Extended manifest rejected: base URI ' + JSON.stringify(baseUri) + ' is not an absolute URL');
        }
        return false;
    }

    if (parsedBaseUri.protocol !== 'http:' && parsedBaseUri.protocol !== 'https:') {
        if (logger) {
            logger.error('Extended manifest rejected: base URI ' + JSON.stringify(baseUri) + ' is not an absolute http(s) URL');
        }
        return false;
    }

    // Reject base URIs with missing final slash.
    if (parsedBaseUri.pathname.charAt(parsedBaseUri.pathname.length - 1) !== '/') {
        if (logger) {
            logger.error('Extended manifest rejected: base URI ' + JSON.stringify(baseUri) + ' must end in a "/", otherwise its last path segment is dropped when segment URLs are resolved');
        }
        return false;
    }

    // Extended manifests are only valid for static (on-demand) content, but
    // that is not checked here. `@type` is an XML attribute, and this function
    // sees the MPD only as an opaque string, so any check at this point is a
    // substring scan with false negatives ('dynamic' in single quotes, spaces
    // around the equals sign). DodgeHandler.rejectIfDynamic() reads the value
    // DashParser produced instead.

    // An extended manifest MUST contain defended stream info: a non-empty
    // array of stream entries. An empty array (or a non-array value) would
    // pass a plain truthiness check but match no representation, which under
    // strict mode permanently blocks all playback with no error fired.
    if (!Array.isArray(manifest['streams']) || manifest['streams'].length === 0) {
        if (logger) {
            logger.error('Extended manifest rejected: no defended stream info');
        }
        return false;
    }

    // [check the list of defended stream info objects]
    for (let i = 0; i < manifest['streams'].length; i++) {
        const stream = manifest['streams'][i];

        // Defended stream info MUST be labeled with a representation.
        // Here, we only check that the label is present, not that it
        // corresponds to a valid representation.
        if (typeof stream['label'] !== 'string' && !(stream['label'] instanceof String)) {
            if (logger) {
                logger.error('Extended manifest rejected: defended stream info at index ' + i + ', missing label');
            }
            return false;
        }

        // period is optional. When present, scopes this stream entry to a
        // specific period in multi-period MPDs. Must be a non-negative integer.
        // Strings are accepted if they parse to a non-negative integer.
        if (stream['period'] !== undefined && stream['period'] !== null) {
            const p = Number(stream['period']);
            if (isNaN(p) || p < 0 || !Number.isInteger(p)) {
                if (logger) {
                    logger.error('Extended manifest rejected: defended stream info with label ' + stream['label'] + ', invalid period');
                }
                return false;
            }
            stream['period'] = p;
        }

        // progressive is optional. When true, this stream's data cycles are
        // incomplete and will be extended at runtime via appendDataCycles /
        // finalizeStream (progressive defense generation). The override stalls
        // when playback runs off the end of a progressive stream's data. A
        // progressive seed's data MUST be self-contained (enforced by
        // checkDataCycles), since later appended batches cannot flush
        // an earlier batch's segment indices.
        if (stream['progressive'] !== undefined && stream['progressive'] !== null) {
            let progressive = stream['progressive'];
            if (typeof progressive === 'string') {
                if (progressive === 'true') {
                    progressive = true;
                } else if (progressive === 'false') {
                    progressive = false;
                } else {
                    if (logger) {
                        logger.error('Extended manifest rejected: defended stream info with label ' + stream['label'] + ', invalid progressive value');
                    }
                    return false;
                }
            } else if (typeof progressive !== 'boolean') {
                if (logger) {
                    logger.error('Extended manifest rejected: defended stream info with label ' + stream['label'] + ', invalid progressive value');
                }
                return false;
            }
            stream['progressive'] = progressive;
        }

        // init is optional for self-initialized streams (no init segment needed)
        // data is optional for init-only streams (e.g. non-fragmented text)
        // At least one of init or data must be non-empty.
        if (stream['init'] !== undefined && stream['init'] !== null && !Array.isArray(stream['init'])) {
            if (logger) {
                logger.error('Extended manifest rejected: defended stream info with label ' + stream['label'] + ', init is not an array');
            }
            return false;
        }
        if (stream['data'] !== undefined && stream['data'] !== null && !Array.isArray(stream['data'])) {
            if (logger) {
                logger.error('Extended manifest rejected: defended stream info with label ' + stream['label'] + ', data is not an array');
            }
            return false;
        }

        const hasInit = Array.isArray(stream['init']) && stream['init'].length > 0;
        const hasData = Array.isArray(stream['data']) && stream['data'].length > 0;
        if (!hasInit && !hasData) {
            if (logger) {
                logger.error('Extended manifest rejected: defended stream info with label ' + stream['label'] + ', stream has no init or data cycles');
            }
            return false;
        }

        // Normalize absent arrays so downstream code always sees arrays.
        if (!stream['init']) {
            stream['init'] = [];
        }
        
        if (!stream['data']) {
            stream['data'] = [];
        }

        // [check init cycles]
        if (!checkInitCycles(stream, logger)) {
            return false;
        }

        // [check data cycles]
        if (!checkDataCycles(stream, logger)) {
            return false;
        }
    }

    return true;
}

/**
 * Return the index of the first non-padding data cycle for the given segment
 * index in the given stream entry, or -1 if no such cycle is found.
 * @param {Object} stream - The stream entry from an extended manifest.
 * @param {number} segmentIndex - The segment index to look up.
 * @returns {number}
 */
export function getCycleIndexBySegmentIndex(stream, segmentIndex) {
    const data = stream['data'] || [];

    for (let i = 0; i < data.length; i++) {
        if (segmentIndex == data[i].index && !data[i].padding) {
            return i;
        }
    }

    return -1;
}

/**
 * Singleton that stores and provides access to extended manifests for the
 * lifetime of a media session.
 */
function DefenseRegistry() {

    const context = this.context;

    let instance,
        logger,
        manifestData;

    function setup() {
        logger = getDodgeDebug(context).getLogger(instance);
        manifestData = [];
    }

    // Discard all manifest data currently stored.
    function reset() {
        manifestData = [];
    }

    /**
     * Return true if at least one extended manifest has been stored.
     * @returns {boolean}
     */
    function hasContent() {
        return manifestData.length > 0;
    }

    /**
     * Validate and store an extended manifest. Assigns a unique `manifestId`.
     * @param {Object} content - The parsed extended manifest JSON object.
     * @returns {boolean} True if the extended manifest was accepted.
     */
    function addExtendedManifest(content) {
        // Validate the extended manifest.
        if (!isValidExtendedManifest(content, logger)) {
            return false;
        }

        // Each extended manifest receives a unique ID.
        content['manifestId'] = manifestData.length;

        // Add the extended manifest to manifestData.
        logger.info('Extended manifest accepted');
        manifestData.push(content);

        return true;
    }

    /**
     * Find the first stream entry whose `label` matches the given label across
     * all registered extended manifests. If `periodIndex` is provided, streams
     * with a `period` field only match when `period === periodIndex`; streams
     * without a `period` field match any period.
     * @param {string} label - The representation ID to search for.
     * @param {number|null} [periodIndex] - Optional period index for multi-period MPDs.
     * @returns {Object|null} The matching stream entry, or null if not found.
     */
    function getDefendedStreamInfo(label, periodIndex = null) {
        for (let i = 0; i < manifestData.length; i++) {
            const manifest = manifestData[i];

            for (let j = 0; j < manifest['streams'].length; j++) {
                const stream = manifest['streams'][j];

                if (label !== stream['label']) {
                    continue;
                }

                // When the stream has a `period` field and a periodIndex was
                // supplied, they must match. Streams without a `period` field
                // match any period (single-period backward compatibility).
                if (periodIndex !== null && stream['period'] !== undefined && stream['period'] !== null) {
                    if (stream['period'] !== periodIndex) {
                        continue;
                    }
                }

                return stream;
            }
        }

        return null;
    }

    /**
     * Every stored stream entry, across all registered extended manifests, in
     * registration order. Used by the load-time cross-check against the MPD,
     * which has to walk the entries rather than look them up by label.
     *
     * @returns {Array<Object>} The stream entries, by reference.
     */
    function getAllStreams() {
        const streams = [];
        for (let i = 0; i < manifestData.length; i++) {
            for (let j = 0; j < manifestData[i]['streams'].length; j++) {
                streams.push(manifestData[i]['streams'][j]);
            }
        }
        return streams;
    }

    /**
     * Append data cycles to a progressive stream at runtime. The append is
     * atomic and self-contained:
     *
     *  - The stream must exist and have `progressive: true` (a finalized or
     *    non-progressive stream cannot be appended to).
     *  - Every cycle is structurally validated; on any failure, the stream is
     *    left untouched and false is returned.
     *  - `full` flags are computed over the batch alone, starting from an empty
     *    pending set. Every non-padding segment index the batch introduces MUST
     *    be flushed (buffered) within the batch, and any selective buffer array
     *    may only reference indices introduced by the batch. A batch is a
     *    complete buffer window. A batch that leaves an index unflushed,
     *    or references an index from an earlier batch, is rejected.
     *
     * On success, the cycles are appended (with correct `full` flags), maxNoPad
     * is recomputed, and true is returned. Because getDefendedStreamInfo returns
     * the stored stream by reference and DodgeDashHandlerOverride re-reads it on
     * every request, the appended cycles are visible to the next
     * getNextSegmentRequest with no further modifications.
     *
     * @param {string} label - The stream label (representation ID).
     * @param {number|null} periodIndex - Optional period index for multi-period MPDs.
     * @param {Array} cycles - The data cycles to append.
     * @returns {boolean} True if the batch was accepted and appended.
     */
    function appendDataCycles(label, periodIndex, cycles) {
        if (!Array.isArray(cycles) || cycles.length === 0) {
            return false;
        }

        const stream = getDefendedStreamInfo(label, periodIndex === undefined ? null : periodIndex);
        if (!stream) {
            logger.error('appendDataCycles: no stream found for label ' + label + ', period ' + periodIndex);
            return false;
        }
        if (!stream['progressive']) {
            logger.error('appendDataCycles: stream ' + label + ' is not progressive (already finalized or never progressive)');
            return false;
        }

        // Work on clones so a validation failure mutates nothing (atomicity).
        const batch = [];
        for (let i = 0; i < cycles.length; i++) {
            const clone = Object.assign({}, cycles[i]);
            if (Array.isArray(clone.buffer)) {
                clone.buffer = clone.buffer.slice();
            }
            if (!checkDataCycleFields(stream['label'], clone, i, logger)) {
                return false;
            }
            batch.push(clone);
        }

        // Self-contained batch: full computed over the batch alone, every
        // introduced index required to be flushed within the batch.
        if (!computeDataCycleFull(batch, true, stream['label'], logger)) {
            return false;
        }

        if (!checkRangeContiguity(batch, stream['label'], false, logger)) {
            return false;
        }

        // Commit. Already-consumed cycles are never touched.
        for (let i = 0; i < batch.length; i++) {
            stream['data'].push(batch[i]);
        }
        stream.maxNoPad = computeMaxNoPad(stream['data']);
        return true;
    }

    /**
     * Finalize a progressive stream: append optional trailing padding cycles,
     * clear the `progressive` flag, and recompute maxNoPad. After this, the
     * override finishes (rather than stalls) when it runs off the end of the
     * data. Trailing cycles MUST be padding cycles: they are never assembled
     * (`full` is always false) and never introduce flushable indices, so
     * appending them cannot disturb any earlier cycle's `full` flag. To
     * append a final batch of real content, call appendDataCycles first,
     * then finalizeStream with only the trailing padding.
     *
     * @param {string} label - The stream label (representation ID).
     * @param {number|null} periodIndex - Optional period index for multi-period MPDs.
     * @param {Array} [paddingCycles] - Trailing padding cycles to append.
     * @returns {boolean} True if the stream was finalized.
     */
    function finalizeStream(label, periodIndex, paddingCycles = []) {
        if (!Array.isArray(paddingCycles)) {
            return false;
        }

        const stream = getDefendedStreamInfo(label, periodIndex === undefined ? null : periodIndex);
        if (!stream) {
            logger.error('finalizeStream: no stream found for label ' + label + ', period ' + periodIndex);
            return false;
        }
        if (!stream['progressive']) {
            logger.error('finalizeStream: stream ' + label + ' is not progressive (already finalized or never progressive)');
            return false;
        }

        const batch = [];
        for (let i = 0; i < paddingCycles.length; i++) {
            const clone = Object.assign({}, paddingCycles[i]);
            if (Array.isArray(clone.buffer)) {
                clone.buffer = clone.buffer.slice();
            }
            if (!checkDataCycleFields(stream['label'], clone, i, logger)) {
                return false;
            }
            if (clone.padding !== true) {
                logger.error('finalizeStream: trailing cycle at index ' + i + ' must be a padding cycle');
                return false;
            }
            clone.full = false;
            batch.push(clone);
        }

        for (let i = 0; i < batch.length; i++) {
            stream['data'].push(batch[i]);
        }
        stream['progressive'] = false;
        stream.maxNoPad = computeMaxNoPad(stream['data']);
        return true;
    }

    instance = {
        addExtendedManifest,
        appendDataCycles,
        finalizeStream,
        getAllStreams,
        getDefendedStreamInfo,
        hasContent,
        reset,
        setup
    };

    setup();

    return instance;
}

DefenseRegistry.__dashjs_factory_name = 'DefenseRegistry';
export default FactoryMaker.getSingletonFactory(DefenseRegistry);
export {isValidExtendedManifest};
