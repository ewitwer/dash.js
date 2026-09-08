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

import DefenseRegistry, { getCycleIndexBySegmentIndex } from '../DefenseRegistry.js';
import DashConstants from '../../dash/constants/DashConstants.js';
import DodgeConstants from '../constants/DodgeConstants.js';
import { createStrictModeReader } from '../utils/StrictMode.js';
import Settings from '../../core/Settings.js';
import { processUriTemplate } from '../../dash/utils/SegmentsUtils.js';
import FragmentRequest from '../../streaming/vo/FragmentRequest.js';
import {HTTPRequest} from '../../streaming/vo/metrics/HTTPRequest.js';

/**
 * Dodge override, replaces DashHandler's request generation logic to use
 * cycles from an extended manifest.
 * 
 * Registered via mediaPlayer.extend('DashHandler', DodgeDashHandlerOverride, true).
 */
function DodgeDashHandlerOverride(config) {
    config = config || {};
    const context = this.context;
    const parent = this.parent;
    const _parentInitialize = parent.initialize;
    const _parentReset = parent.reset;
    const _parentGetInitRequest = parent.getInitRequest;
    const _parentGetNextSegmentRequest = parent.getNextSegmentRequest;
    const _parentGetNextSegmentRequestIdempotent = parent.getNextSegmentRequestIdempotent;
    const _parentGetSegmentRequestForTime = parent.getSegmentRequestForTime;
    const _parentIsLastSegmentRequested = parent.isLastSegmentRequested;

    const defenseRegistry = DefenseRegistry(context).getInstance();
    const settings = Settings(context).getInstance();
    const adapter = config.adapter;
    const baseURLController = config.baseURLController;
    const urlUtils = config.urlUtils;
    const timelineConverter = config.timelineConverter;
    const segmentsController = config.segmentsController;
    const playbackController = config.playbackController;
    const eventBus = config.eventBus;
    const events = config.events;
    const debug = config.debug;

    let logger,
        getStrictMode;

    let defendedStreamInfo,
        lastInitIndex,
        lastCycleIndex,
        lastSegment,
        timelineSegments,
        mediaHasFinished,
        lastResolvedLabel,
        reportedLabels;

    function setup() {
        logger = debug.getLogger({ __dashjs_factory_name: 'DodgeDashHandlerOverride' });
        getStrictMode = createStrictModeReader(settings, logger);
        _resetState();
    }

    function _resetState() {
        defendedStreamInfo = null;
        lastInitIndex = -1;
        lastCycleIndex = -1;
        lastSegment = null;
        timelineSegments = new WeakMap();
        mediaHasFinished = false;
        lastResolvedLabel = null;
        reportedLabels = new Set();
    }

    // Every mode other than NONE enforces per-representation defense
    // requirements. The reader guarantees one of the four accepted values, so
    // there is nothing else this can be.
    function _isRepresentationStrict() {
        return getStrictMode() !== DodgeConstants.STRICT_MODE.NONE;
    }
    
    function reset() {
        _resetState();
        _parentReset.call(parent);
    }

    function initialize(isDynamic) {
        mediaHasFinished = false;
        _parentInitialize.call(parent, isDynamic);
    }

    // ************************************************************************
    // REQUEST URL
    // ************************************************************************

    /**
     * Set the request URL, resolving it against the BaseURL the way vanilla
     * DashHandler does, and attach a cache-busting query value.
     *
     * Wire size is normalized later, by applyRequestPadding() in the loader
     * overrides, which extends this same query parameter until the whole
     * request reaches dodge.paddingLengthBase.
     */
    function _setRequestUrlWithCacheBuster(request, destination, representation) {
        const baseURL = baseURLController.resolve(representation.path);
        let url, serviceLocation, queryParams = {};

        if (!baseURL || (destination === baseURL.url) || (!urlUtils.isRelative(destination))) {
            url = destination;
        } else {
            url = baseURL.url;
            serviceLocation = baseURL.serviceLocation;
            // Clone: every request resolved against the same BaseURL would
            // otherwise share one queryParams object, leaving in-flight
            // requests pointing at the newest random value.
            queryParams = baseURL.queryParams ? Object.assign({}, baseURL.queryParams) : {};

            if (destination) {
                url = urlUtils.resolve(destination, url);
            }
        }

        if (urlUtils.isRelative(url)) {
            return false;
        }

        const queryParam = (settings.get().dodge || {}).queryParam || 'padding';
        queryParams[queryParam] = Math.random().toString(36).substring(2, 10);

        request.url = url;
        request.serviceLocation = serviceLocation;
        request.queryParams = queryParams;

        return true;
    }

    // ************************************************************************
    // INIT REQUEST GENERATION
    // ************************************************************************

    function getInitRequest(mediaInfo, representation) {
        if (!representation || !defendedStreamInfo) {
            if (_isRepresentationStrict() && defenseRegistry.hasContent()) {
                return null; // block undefended request
            }
            // No extended manifest loaded, fall back to vanilla DashHandler.
            return _parentGetInitRequest.call(parent, mediaInfo, representation);
        }

        const initIndex = lastInitIndex + 1;
        const cycle = defendedStreamInfo['init'][initIndex];
        if (!cycle) {
            return null;
        }

        // Resolve the effective representation for this init cycle. When
        // cycle.quality is present, fetch the alternate representation's init
        // segment so it is cached in the Dodge-owned cache under that rep's ID
        // (required by the handling in DodgeBufferControllerOverride). On any
        // resolution failure, stall + never silently fall back to the home
        // representation, which would corrupt the defense.
        const effectiveRep = _resolveCycleRepresentation(representation, cycle);
        if (!effectiveRep) {
            return null;
        }

        const request = _generateInitRequest(mediaInfo, effectiveRep, representation.mediaInfo.type, cycle.range, cycle.padding);
        if (!request) {
            // URL resolution failed: stall without advancing lastInitIndex, so
            // the scheduler retries this same init cycle. Advancing here would
            // skip the cycle and corrupt the defense's init sequence.
            return null;
        }

        lastInitIndex = initIndex;

        request.full = !!cycle.full;
        request.buffer = !!cycle.buffer;
        if (effectiveRep.id !== representation.id) {
            request.homeRepresentationId = representation.id;
        }
        return request;
    }

    function _generateInitRequest(mediaInfo, representation, mediaType, range = null, padding = false) {
        const request = new FragmentRequest();
        const period = representation.adaptation.period;
        const presentationStartTime = period.start;
        const isDynamicManifest = parent.getStreamInfo().manifestInfo.isDynamic;

        // SegmentBase / byte-range: initialization URL is null and resolves
        // from BaseURL at load time.
        const initUrl = representation.initialization;

        request.mediaType = mediaType;
        request.type = HTTPRequest.INIT_SEGMENT_TYPE;
        request.originalRange = representation.range;
        if (range) {
            request.range = range;
            request.partial = true;
        } else {
            request.range = representation.range;
            request.partial = false;
        }
        if (padding) {
            request.padding = true;
        }
        request.availabilityStartTime = timelineConverter.calcAvailabilityStartTimeFromPresentationTime(presentationStartTime, representation, isDynamicManifest);
        request.availabilityEndTime = timelineConverter.calcAvailabilityEndTimeFromPresentationTime(presentationStartTime + period.duration, representation, isDynamicManifest);
        request.representation = representation;

        if (_setRequestUrlWithCacheBuster(request, initUrl, representation)) {
            if (initUrl) {
                // DashManifestModel substitutes $Bandwidth$ and $RepresentationID$
                // into representation.initialization at parse time, so this pass
                // normally only resolves the $$ escape. It mirrors vanilla
                // DashHandler rather than assuming that, so the two cannot drift.
                request.url = processUriTemplate(
                    request.url, representation.id, undefined, undefined, representation.bandwidth);
            }
            return request;
        }
    }

    // ************************************************************************
    // DATA REQUEST GENERATION
    // ************************************************************************

    /**
     * Resolve the effective representation for a data cycle. When cycle.quality
     * is present, it selects an alternate representation in the same adaptation
     * set to fetch this cycle from. Accepts a string matched against
     * representation.id, or a non-negative integer index into the array
     * returned by adapter.getVoRepresentations(mediaInfo).
     *
     * Returns the current representation when no override is present, the
     * resolved alternate representation when the override is valid, or null
     * when the override cannot be honored. Callers MUST treat null as a stall
     * condition and return null from their own request generation path; they
     * MUST NOT fall back to current representation, as that would silently
     * corrupt the defense shape (wrong wire size, wrong range semantics).
     */
    function _resolveCycleRepresentation(currentRep, cycle) {
        if (!cycle || cycle.quality === undefined || cycle.quality === null) {
            return currentRep;
        }
        const siblings = (adapter && currentRep && currentRep.mediaInfo)
            ? adapter.getVoRepresentations(currentRep.mediaInfo)
            : null;
        if (!siblings || siblings.length === 0) {
            logger.error('Cycle quality override: "' + cycle.quality + '" cannot be honored, no sibling representations available');
            return null;
        }
        let altRep = null;
        if (typeof cycle.quality === 'number') {
            if (cycle.quality >= 0 && cycle.quality < siblings.length) {
                altRep = siblings[cycle.quality];
            }
        } else if (typeof cycle.quality === 'string') {
            for (let i = 0; i < siblings.length; i++) {
                if (siblings[i] && siblings[i].id === cycle.quality) {
                    altRep = siblings[i];
                    break;
                }
            }
        }
        if (!altRep) {
            logger.error('Cycle quality override: "' + cycle.quality + '" did not resolve to a sibling representation');
            return null;
        }
        return altRep;
    }

    /**
     * Resolve a segment by its index.
     *
     * SegmentsController routes SegmentTimeline to a getter that takes no index
     * at all: TimelineSegmentsGetter.getSegmentByIndex() reads the fourth
     * argument (`lastSegment`) and returns the segment after it, falling back to
     * the segment at time 0 when there is none. An index-based call therefore
     * yields segment 0 for every cycle. Cycles address arbitrary indices and
     * padding cycles repeat them, so a forward cursor is not a substitute.
     *
     * Step that cursor instead, which keeps the walk free of any assumption
     * about <S> parsing, and memoize what it returns. `<S>` entries carry
     * per-entry @d, so there is no arithmetic that converts an index to a;
     * time only the getter's own iteration knows the mapping.
     */
    function _getSegmentByIndex(representation, index) {
        if (!representation || representation.segmentInfoType !== DashConstants.SEGMENT_TIMELINE) {
            // NaN, not -1, is how vanilla DashHandler says "not a partial segment
            // request". TemplateSegmentsGetter keeps any subNumber below
            // SegmentTemplate@k as given, so -1 selects partial segment -1: a
            // negative presentation time and a literal -1 in $SubNumber$.
            return segmentsController.getSegmentByIndex(representation, index, NaN);
        }

        // Keyed on the representation object rather than its ID: a multi-period
        // MPD can reuse an ID across periods with different timelines. Extended
        // manifests reject dynamic MPDs, so a resolved timeline never changes
        // underneath the cache.
        let segments = timelineSegments.get(representation);
        if (!segments) {
            segments = [];
            timelineSegments.set(representation, segments);
        }

        while (!segments[index]) {
            // Arguments two and three are ignored for SegmentTimeline; the
            // getter reads only the cursor.
            const next = segmentsController.getSegmentByIndex(
                representation, NaN, NaN, segments[segments.length - 1] || null);
            if (!next) {
                return null; // past the end of the timeline
            }
            segments[next.index] = next;
        }

        // The getter writes representation.segmentDuration on every match, so
        // a cache hit would otherwise leave it reading whichever segment
        // was resolved last. DodgeBufferControllerOverride does mock buffer
        // arithmetic with that value and the trailing-seek guard compares
        // against it, and timeline segment durations are not uniform.
        representation.segmentDuration = segments[index].duration;

        return segments[index];
    }

    function _getRequestForSegment(mediaInfo, segment, range = null, padding = false, homeRepresentation = null) {
        if (segment === null || segment === undefined) {
            return null;
        }

        const request = new FragmentRequest();
        const representation = segment.representation;
        const bandwidth = representation.bandwidth;
        // SegmentBase / byte-range leaves segment.media null, because all
        // segments share a single file URL resolved from BaseURL.
        // The time-based getters already expanded the template, but this mirrors
        // the second pass vanilla DashHandler still makes, and it is what expands
        // a SegmentList @media: ListSegmentsGetter overwrites segment.media with
        // the raw SegmentURL@media after getIndexBasedSegment() has run.
        const url = processUriTemplate(
            segment.media,
            representation.id,
            segment.replacementNumber,
            segment.replacementSubNumber,
            bandwidth,
            segment.replacementTime
        );

        request.mediaType = parent.getType();
        request.bandwidth = representation.bandwidth;
        request.type = HTTPRequest.MEDIA_SEGMENT_TYPE;
        request.originalRange = segment.mediaRange;
        if (range) {
            request.range = range;
            request.partial = true;
        } else {
            request.range = segment.mediaRange;
            request.partial = false;
        }
        if (padding) {
            request.padding = true;
        }
        request.startTime = segment.presentationStartTime;
        request.mediaStartTime = segment.mediaStartTime;
        request.duration = segment.duration;
        request.timescale = representation.timescale;
        request.availabilityStartTime = segment.availabilityStartTime;
        request.availabilityEndTime = segment.availabilityEndTime;
        request.availabilityTimeComplete = representation.availabilityTimeComplete;
        request.wallStartTime = segment.wallStartTime;
        request.index = segment.index;
        request.adaptationIndex = representation.adaptation.index;
        request.representation = representation;
        if (homeRepresentation) {
            request.homeRepresentationId = homeRepresentation.id;
        }

        if (_setRequestUrlWithCacheBuster(request, url, representation)) {
            return request;
        }
    }

    function getSegmentRequestForTime(mediaInfo, representation, time) {
        if (!representation || !representation.segmentInfoType || !defendedStreamInfo) {
            if (_isRepresentationStrict() && defenseRegistry.hasContent()) {
                return null; // block undefended request
            }
            // No extended manifest, fall back to vanilla DashHandler.
            return _parentGetSegmentRequestForTime.call(parent, mediaInfo, representation, time);
        }

        // If we are trailing and a spurious seek occurs (it shouldn't),
        // ignore it. But if the user seeks to at least one segment before
        // the end of the stream, allow it.
        if (playbackController.getTimeSinceStreamEnd() > 0 && playbackController.getStreamEndTime(representation.mediaInfo.streamInfo) - time < representation.segmentDuration) {
            return getNextSegmentRequest(mediaInfo, representation);
        }

        // Start with the segment. Resolve segment.index from the current
        // representation's timeline (authoritative for playback).
        let segment = segmentsController.getSegmentByTime(representation, time);
        if (!segment) {
            logger.debug('No segment found for time ' + time);
            return null;
        } else {
            logger.debug('Index for time ' + time + ' is ' + segment.index);
        }

        // Find first cycle containing the desired segment.
        const cycleIndex = getCycleIndexBySegmentIndex(defendedStreamInfo, segment.index);
        const cycle = defendedStreamInfo['data'][cycleIndex];
        if (!cycle) {
            return null;
        }

        // If this cycle carries a quality override, re-lookup the segment
        // against the alternate representation so the URL template and
        // bandwidth/id substitutions reflect the alternate quality. On any
        // failure (bad override, alt rep missing this segment index), stall
        // by returning null, mirroring the behavior below for a missing
        // segment in the current representation. We must not fall back to
        // the current representation, which would silently corrupt the
        // defense shape (wrong wire size, broken range semantics).
        if (cycle.quality !== undefined && cycle.quality !== null) {
            const effectiveRep = _resolveCycleRepresentation(representation, cycle);
            if (!effectiveRep) {
                return null;
            }
            const altSegment = _getSegmentByIndex(effectiveRep, segment.index);
            if (!altSegment) {
                logger.error('Cycle quality override: alternate representation "' + effectiveRep.id + '" has no segment for index ' + segment.index);
                return null;
            }
            segment = altSegment;
            logger.debug('New index for time ' + time + ' in alternate representation is ' + segment.index);
        }

        // Determine whether a quality override changed the representation.
        const homeRep = (segment.representation.id !== representation.id) ? representation : null;

        const request = _getRequestForSegment(mediaInfo, segment, cycle.range, cycle.padding, homeRep);
        if (!request) {
            // URL resolution failed: stall without advancing lastCycleIndex or
            // mutating lastSegment, so the scheduler retries this same cycle.
            return null;
        }

        // Update invariants only after a request was successfully built.
        lastCycleIndex = cycleIndex;
        lastSegment = segment;

        request.full = !!cycle.full;
        request.buffer = Array.isArray(cycle.buffer) ? cycle.buffer : !!cycle.buffer;
        request.padding = !!cycle.padding;
        request.trail = cycleIndex > defendedStreamInfo['maxNoPad'];
        return request;
    }

    function getNextSegmentRequest(mediaInfo, representation) {
        if (!representation || !representation.segmentInfoType || !defendedStreamInfo) {
            if (_isRepresentationStrict() && defenseRegistry.hasContent()) {
                return null; // block undefended request
            }
            // No extended manifest, fall back to vanilla DashHandler.
            return _parentGetNextSegmentRequest.call(parent, mediaInfo, representation);
        }

        // Init-only defended stream (e.g. non-fragmented text): no data cycles to serve.
        if (defendedStreamInfo['data'].length === 0) {
            // A progressive manifest may not have its first data batch yet:
            // stall (await the next append) rather than finishing.
            if (defendedStreamInfo['progressive']) {
                return null;
            }
            mediaHasFinished = true;
            return null;
        }

        // Advance to next cycle.
        const cycleIndex = lastCycleIndex + 1;
        const cycle = defendedStreamInfo['data'][cycleIndex];
        if (!cycle) {
            // Progressive (incomplete) manifest: playback has caught up to the
            // end of the cycles generated so far. Stall (return null without
            // setting mediaHasFinished) so the scheduler retries once the next
            // batch is appended; finalizeStream() turns progressive off when the
            // defense is complete.
            if (defendedStreamInfo['progressive']) {
                logger.debug('No cycle at index ' + cycleIndex + ' yet; progressive manifest not finalized, stalling');
                return null;
            }
            logger.debug('No cycle found with index ' + cycleIndex);
            mediaHasFinished = true;
            return null;
        }

        // Resolve the effective representation for this cycle (may be an
        // alternate quality override). A failed override returns null and
        // must stall, as falling back to the current representation would
        // silently corrupt the defense shape. A missing cycle.quality is not
        // a failure; _resolveCycleRepresentation just returns currentRep.
        const effectiveRep = _resolveCycleRepresentation(representation, cycle);
        if (!effectiveRep) {
            return null;
        }

        // Reuse the cached lastSegment only when the effective representation
        // matches the current one AND the cache was produced under that same
        // representation, otherwise the cached segment would carry a stale
        // representation and generate an incorrect URL.
        const canReuseLast = lastSegment && cycle.index == lastSegment.index &&
            effectiveRep.id === representation.id &&
            lastSegment.representation.id === representation.id;

        // Reuse lastSegment or look up segment by index.
        const segment = canReuseLast
            ? lastSegment
            : _getSegmentByIndex(effectiveRep, cycle.index);
        if (!segment) {
            if (cycle.quality !== undefined && cycle.quality !== null) {
                logger.error('Cycle quality override: alternate representation "' + effectiveRep.id + '" has no segment for index ' + cycle.index);
            } else {
                logger.debug('No segment found, lastSegment = ' + !!lastSegment);
            }
            return null;
        }

        if (canReuseLast) {
            effectiveRep.segmentDuration = segment.duration;
        }

        // Determine whether a quality override changed the representation.
        const homeRep = (effectiveRep.id !== representation.id) ? representation : null;

        const request = _getRequestForSegment(mediaInfo, segment, cycle.range, cycle.padding, homeRep);
        if (!request) {
            // URL resolution failed: stall without advancing lastCycleIndex or
            // mutating lastSegment, so the scheduler retries this same cycle.
            return null;
        }

        // Update invariants only after a request was successfully built.
        lastCycleIndex = cycleIndex;
        if (!cycle.padding) {
            lastSegment = segment;
        }

        request.full = !!cycle.full;
        request.buffer = Array.isArray(cycle.buffer) ? cycle.buffer : !!cycle.buffer;
        request.padding = !!cycle.padding;
        request.trail = cycleIndex > defendedStreamInfo['maxNoPad'];
        return request;
    }

    /**
     * CMCD probing: return null during defended playback so that nor/nrr
     * headers are not emitted - advertising the next cycle's URL or byte
     * range is not desirable.
     */
    function getNextSegmentRequestIdempotent(mediaInfo, representation) {
        if (!representation || !representation.segmentInfoType || !defendedStreamInfo) {
            if (_isRepresentationStrict() && defenseRegistry.hasContent()) {
                return null;
            }
            // Fall back to vanilla DashHandler.
            return _parentGetNextSegmentRequestIdempotent.call(parent, mediaInfo, representation);
        }

        return null;
    }

    function isLastSegmentRequested(representation, bufferingTime) {
        if (!defendedStreamInfo) {
            if (_isRepresentationStrict() && defenseRegistry.hasContent()) {
                return false; // stall undefended stream
            }
            // Fall back to vanilla DashHandler.
            return _parentIsLastSegmentRequested.call(parent, representation, bufferingTime);
        }

        // Progressive (incomplete) manifest: never report the last segment as
        // requested until finalizeStream() clears the flag, even if playback
        // has temporarily caught up to the last generated cycle. Otherwise the
        // player would declare the stream finished while more cycles are still
        // being generated.
        if (defendedStreamInfo['progressive']) {
            return false;
        }

        // Init-only defended stream: finished once getNextSegmentRequest has been called.
        if (defendedStreamInfo['data'].length === 0) {
            return mediaHasFinished;
        }

        if (!representation || !lastSegment || lastCycleIndex < 0) {
            return false;
        }

        if (mediaHasFinished) {
            return true;
        }

        if (!isNaN(bufferingTime) && lastSegment.presentationStartTime + lastSegment.duration > bufferingTime) {
            return false;
        }

        if (lastCycleIndex >= defendedStreamInfo['data'].length - 1) {
            return true;
        }

        return false;
    }

    function repeatSegmentRequest(mediaInfo, representation) {
        if (!lastSegment) {
            return null;
        }
        return getSegmentRequestForTime(mediaInfo, representation, lastSegment.presentationStartTime);
    }

    // ************************************************************************
    // GETTERS AND SETTERS
    // ************************************************************************

    function getCurrentIndex() {
        return lastSegment ? lastSegment.index : -1;
    }

    function getLastSegment() {
        return lastSegment;
    }

    /**
     * How many init cycles are still needed, for the representation the
     * caller names. ScheduleController uses this to choose the init path over
     * the media path, and it asks before StreamProcessor has called
     * updateDefendedStreamInfo for the switch it is about to make, so the state
     * here still describes the representation being switched away from. That
     * one has no init cycles left, and answering 0 sends the scheduler down the
     * media path: the new representation's first media segment would then go
     * out before any of its init cycles. Answer for the representation asked
     * about instead. Callers that mean "the stream in use" pass nothing.
     *
     * @param {Object} [representation] - The representation being asked about.
     * @returns {number} Remaining init cycles, or -1 when no defense covers it.
     */
    function getRemainingInitCycles(representation) {
        if (!defendedStreamInfo) { return -1; }

        if (representation && representation.id !== lastResolvedLabel) {
            const pending = defenseRegistry.getDefendedStreamInfo(representation.id, representation.adaptation.period.index);
            return pending ? pending['init'].length : -1;
        }

        return defendedStreamInfo['init'].length - lastInitIndex - 1;
    }

    /**
     * Serve the init cycle sequence again from the start.
     *
     * ScheduleController calls this when the player asks for an init segment
     * on a representation whose cycles are already used up. A seek aborts the
     * SourceBuffer, and StreamProcessor then sets `initSegmentRequired` so the
     * init segment is appended again.
     *
     * Only the init counter moves. `lastCycleIndex` and `lastSegment` describe
     * where playback is in the data cycles, which a re-init does not change.
     *
     * @returns {number} Init cycles now to be sent, or -1 when no defense covers
     *          the stream.
     */
    function restartInitCycles() {
        if (!defendedStreamInfo) {
            return -1;
        }

        lastInitIndex = -1;
        return defendedStreamInfo['init'].length;
    }

    function updateDefendedStreamInfo(representation) {
        if (!representation) {
            defendedStreamInfo = null;
            return false;
        }

        const period = representation.adaptation.period.index;
        const adaptation = representation.adaptation.index;
        const quality = representation.index;
        const label = representation.id;

        // On a home representation switch (e.g. ABR picked a different
        // quality), the counters cannot carry over: each stream entry owns its
        // cycle array, so cycle N of the new one is an unrelated part of the
        // defense. StreamProcessor calls this method before every init/segment
        // request, so same-label re-queries preserve state; only a genuine
        // label change moves the counters.
        const previousLabel = lastResolvedLabel;
        const previousSegment = lastSegment;
        lastResolvedLabel = label;

        defendedStreamInfo = defenseRegistry.getDefendedStreamInfo(label, period);

        if (previousLabel !== null && previousLabel !== label) {
            logger.debug('Home representation switched from ' + previousLabel + ' to ' + label);

            // The new representation needs its own init segment, so its init
            // cycles start over. lastSegment described a segment of the old
            // representation and would generate that representation's URL,
            // so it goes; the next request looks the segment up afresh.
            lastInitIndex = -1;
            lastCycleIndex = -1;
            lastSegment = null;
            mediaHasFinished = false;

            // Data cycles resume at the segment index that was last requested,
            // rather than restarting the video from the beginning of the new
            // cycle array. That index is re-fetched under the new representation
            // instead of skipped: a switch can land between two cycles of the
            // same segment, and continuing past a segment that was never
            // assembled would leave a hole in the buffer.
            if (defendedStreamInfo && previousSegment) {
                const resumeIndex = getCycleIndexBySegmentIndex(defendedStreamInfo, previousSegment.index);
                if (resumeIndex >= 0) {
                    lastCycleIndex = resumeIndex - 1;
                } else {
                    logger.warn('Representation "' + label + '" has no data cycle for segment index ' +
                        previousSegment.index + ', which the representation switched away from had reached. ' +
                        'Playback restarts at the beginning of this representation\'s cycles. ' +
                        'Give every defended representation of a source the same segment indices!');
                }
            }
            
            eventBus.trigger(events.REPRESENTATION_SWITCHED,
                { previousRepresentationId: previousLabel },
                { streamId: parent.getStreamId(), mediaType: parent.getType() }
            );
        }

        if (defendedStreamInfo) {
            logger.debug('Defended stream info set for label ' + label + ', period ' + period + ', adaptation ' + adaptation + ', quality ' + quality);
        } else if (!reportedLabels.has(label)) {
            reportedLabels.add(label);
            if (_isRepresentationStrict() && defenseRegistry.hasContent()) {
                logger.error('Dodge strict mode is enabled and no defended stream info for label ' + label + ', blocking requests');
            } else {
                logger.debug('Defended stream info not found for label ' + label + ', period ' + period + ', adaptation ' + adaptation + ', quality ' + quality);
            }
        }

        return !!defendedStreamInfo;
    }

    function getIsDefended() {
        return !!defendedStreamInfo;
    }

    function getIsTrailing() {
        return !!(defendedStreamInfo && lastCycleIndex >= defendedStreamInfo['maxNoPad'] && lastCycleIndex < defendedStreamInfo['data'].length - 1);
    }

    setup();

    return {
        initialize,
        reset,
        getInitRequest,
        getNextSegmentRequest,
        getNextSegmentRequestIdempotent,
        getSegmentRequestForTime,
        isLastSegmentRequested,
        repeatSegmentRequest,
        getCurrentIndex,
        getLastSegment,
        getRemainingInitCycles,
        restartInitCycles,
        updateDefendedStreamInfo,
        getIsDefended,
        getIsTrailing,
    };
}

export default DodgeDashHandlerOverride;
