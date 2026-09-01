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

import DataChunk from '../streaming/vo/DataChunk.js';
import DashJSError from '../streaming/vo/DashJSError.js';
import Debug from '../core/Debug.js';
import DefenseRegistry from './DefenseRegistry.js';
import DodgeBufferControllerOverride from './overrides/DodgeBufferControllerOverride.js';
import DodgeDashHandlerOverride from './overrides/DodgeDashHandlerOverride.js';
import DodgeErrors from './errors/DodgeErrors.js';
import DodgeEvents from './events/DodgeEvents.js';
import DodgeFetchLoaderOverride from './overrides/DodgeFetchLoaderOverride.js';
import DodgeGapControllerOverride from './overrides/DodgeGapControllerOverride.js';
import DodgeScheduleControllerOverride from './overrides/DodgeScheduleControllerOverride.js';
import DodgeXHRLoaderOverride from './overrides/DodgeXHRLoaderOverride.js';
import Constants from '../streaming/constants/Constants.js';
import DodgeConstants from './constants/DodgeConstants.js';
import DashConstants from '../dash/constants/DashConstants.js';
import DashManifestModel from '../dash/models/DashManifestModel.js';
import { createStrictModeReader, resolveNumericSetting } from './utils/StrictMode.js';
import FactoryMaker from '../core/FactoryMaker.js';
import EventBus from '../core/EventBus.js';
import { HTTPRequest } from '../streaming/vo/metrics/HTTPRequest.js';

// ABR rules that are compatible with Dodge's cycle-based download model.
// All built-in rules not in these sets are disabled at module load time.
const SUPPORTED_QUALITY_SWITCH_RULES = new Set(['bolaRule', 'throughputRule', 'insufficientBufferRule', 'switchHistoryRule', 'droppedFramesRule']);
const SUPPORTED_ABANDON_FRAGMENT_RULES = new Set();

/**
 * The main orchestrator for the Dodge module. Dodge is a framework that
 * provides the building blocks for client-side, application-layer video
 * fingerprinting defenses. It does not require any changes to servers or
 * network infrastructures, nor does it need to coordinate with servers.
 * All defense logic is handled within dash.js.
 * 
 * Dodge was first described in the PoPETS 2026 paper "Dodge: A Client-Side
 * Framework for Application-Layer Video Fingerprinting Defenses". See the
 * paper for more details about the original design.
 *
 * DodgeHandler has the following responsibilities:
 *  1. Register controller and loader overrides.
 *  2. Intercept manifest loading to detect extended manifests (JSON), add them
 *     to the registry, and extract the embedded MPD + base URI.
 *  3. Intercept FRAGMENT_LOADING_COMPLETED and handle Dodge-specific events
 *     to implement partial segment combination and padding requests.
 *  4. Control random walk scheduling after partial segments/padding cycles.
 *  5. Route onPaddingLoaded to buffer controllers for mock buffer updates.
 */
function DodgeHandler(config) {

    config = config || {};
    const context = this.context;
    const eventBus = config.eventBus;
    const events = config.events;
    const settings = config.settings;
    const streamController = config.streamController;
    const mediaPlayer = config.mediaPlayer;

    const debug = Debug(context).getInstance();
    let logger,
        defenseRegistry,
        dashManifestModel,
        getStrictMode,
        warnedScheduleRandom,
        warnedScheduleBase,
        instance;

    // Per-stream state, keeps track of partial segments and pending events.
    // Key: streamId & Value: { partialSegments, pendingInit, pendingMedia }
    let streamState;

    function setup() {
        logger = debug.getLogger(instance);
        defenseRegistry = DefenseRegistry(context).getInstance();
        dashManifestModel = DashManifestModel(context).getInstance();
        getStrictMode = createStrictModeReader(settings, logger);
        warnedScheduleRandom = false;
        warnedScheduleBase = false;
        streamState = new Map();
    }

    // ************************************************************************
    // PUBLIC API
    // ************************************************************************

    /**
     * Register controller overrides. Must be called before attachSource() so
     * that stream processors are initialized with the Dodge controllers.
     * Called from MediaPlayer._detectDodge() during attachView().
     */
    function registerExtensions() {
        // Set override to true: we only want to replace specific functions
        // (the ones defined in the Dodge controllers). Others should remain
        // unchanged, as in default dash.js
        mediaPlayer.extend('DashHandler', DodgeDashHandlerOverride, true);
        mediaPlayer.extend('BufferController', DodgeBufferControllerOverride, true);
        mediaPlayer.extend('ScheduleController', DodgeScheduleControllerOverride, true);
        mediaPlayer.extend('GapController', DodgeGapControllerOverride, true);
        mediaPlayer.extend('FetchLoader', DodgeFetchLoaderOverride, true);
        mediaPlayer.extend('XHRLoader', DodgeXHRLoaderOverride, true);
        _applyAbrRules();
    }

    /**
     * Register event listeners.
     *  - FRAGMENT_LOADING_COMPLETED (before FragmentController)
     *  - INIT_FRAGMENT_PARTIAL / MEDIA_FRAGMENT_PARTIAL for scheduling
     *  - PADDING_LOADED for scheduling + buffer controller update
     * Called from MediaPlayer._detectDodge() during attachView().
     */
    function registerEvents() {
        // Set high priority to intercept before FragmentController
        eventBus.on(events.FRAGMENT_LOADING_COMPLETED, _onFragmentLoadingCompleted, instance, { priority: EventBus.EVENT_PRIORITY_HIGH });
        // No special priority needed, these are Dodge-specific events
        eventBus.on(events.INIT_FRAGMENT_PARTIAL, _onPartialSegment, instance);
        eventBus.on(events.MEDIA_FRAGMENT_PARTIAL, _onPartialSegment, instance);
        eventBus.on(events.PADDING_LOADED, _onPaddingLoaded, instance);
        // NEED_KEY is observed for diagnostics only.
        if (events.NEED_KEY) {
            eventBus.on(events.NEED_KEY, _onNeedKey, instance);
        }
        if (events.KEY_SESSION_CREATED) {
            eventBus.on(events.KEY_SESSION_CREATED, _onKeySessionCreated, instance);
        }
    }

    /**
     * Called by ManifestLoader before parsing. If `bytes` is a valid extended
     * manifest JSON, register it with DefenseRegistry and return the embedded
     * MPD string and base URI. If not a valid extended manifest, returns null
     * (graceful degradation). If strict mode 'manifest' or 'max' is enabled
     * and no defense can be applied, generates an error and returns false
     * to signal an abort to ManifestLoader.
     * @param {string} bytes - Raw response body.
     * @param {string} [url] - Original request URL, included in error messages.
     * @returns {{ mpd: string, baseUri: string }|null|false}
     */
    function tryProcessExtendedManifest(bytes, url) {
        // 'max' inherits 'manifest' behavior: abort (rather than degrade to
        // vanilla DASH) when the source is not a valid extended manifest.
        const strictMode = getStrictMode();
        const strict = strictMode === DodgeConstants.STRICT_MODE.MANIFEST ||
            strictMode === DodgeConstants.STRICT_MODE.MAX;

        let extended;
        try {
            extended = JSON.parse(bytes);
        } catch (e) {
            if (strict) {
                _triggerStrictModeError(url);
                return false;
            }
            return null; // not valid JSON
        }

        // An extended manifest arriving is the start of a new source, so drop what
        // the previous one left behind.
        defenseRegistry.reset();
        streamState.clear();

        if (!defenseRegistry.addExtendedManifest(extended)) {
            logger.debug('Extended manifest rejected by DefenseRegistry');
            if (strict) {
                _triggerStrictModeError(url);
                return false;
            }
            return null;
        }

        // Everything that depends on the MPD's own structure - thumbnail tracks,
        // sidecar text, XLink, DRM, content steering, DVB reporting - is checked
        // after DashParser has run, by rejectIfUnshapedTracks() and
        // _warnAboutSideChannels(). The checks below need only the settings.
        if (strictMode === DodgeConstants.STRICT_MODE.NONE) {
            logger.warn('Dodge strictMode is disabled, undefended representations will fall back to vanilla dash.js without any defense!');
        }

        // Read through the resolver rather than comparing the raw setting: an
        // unusable value disables padding exactly as 0 does, but every
        // comparison against NaN or a string is false, so a raw `<= 0` 
        // gate would wave the misconfiguration through.
        if (resolveNumericSetting(settings, 'paddingLengthBase').value <= 0) {
            if (strictMode === DodgeConstants.STRICT_MODE.MAX) {
                logger.error('dodge.paddingLengthBase is not set to a positive number, request wire sizes are not normalized, rejected by strict mode max');
                _triggerStrictModeError(url);
                return false;
            } else if (strictMode !== DodgeConstants.STRICT_MODE.NONE) {
                logger.warn('dodge.paddingLengthBase is not set to a positive number, request wire sizes are not normalized, request lengths vary with the content being requested!');
            }
        }

        if (strictMode !== DodgeConstants.STRICT_MODE.NONE && settings.get().streaming.cmcd.enabled) {
            logger.warn('CMCD is enabled during Dodge playback - CMCD data is encrypted and is unlikely to aid passive fingerprinting; nor/nrr fields are suppressed');
        }

        // Init segment caching is outside Dodge's cycle control: an ABR-driven
        // home representation switch triggers an init fetch only when the new
        // rep's init is not already cached. Two videos in an anonymity set
        // with differing init segment structures can therefore produce
        // different wire patterns on switch. Defense designers should
        // either ensure identical init segment structures across their
        // anonymity set, or disable streaming.cacheInitSegments for
        // symmetric (always-refetch) behavior.
        if (strictMode !== DodgeConstants.STRICT_MODE.NONE && settings.get().streaming.cacheInitSegments) {
            logger.warn('streaming.cacheInitSegments is enabled - ABR-driven init refetches on quality switches are not controlled by the extended manifest');
        }

        // In 'max' mode, warn about settings that the defense designer
        // may want to change manually for strict threat models. These are
        // not changed automatically because they are standard dash.js
        // settings that can be set via updateSettings.
        if (strictMode === DodgeConstants.STRICT_MODE.MAX) {
            if (settings.get().streaming.retryAttempts[HTTPRequest.MEDIA_SEGMENT_TYPE] > 0 ||
                settings.get().streaming.retryAttempts[HTTPRequest.INIT_SEGMENT_TYPE] > 0) {
                logger.warn('strictMode max: segment retry attempts > 0, consider setting to 0 for plausible deniability against active attacks');
            }
            if (settings.get().streaming.utcSynchronization.enableBackgroundSyncAfterSegmentDownloadError) {
                logger.warn('strictMode max: background UTC sync on segment download error is enabled, consider disabling for plausible deniability against active attacks');
            }
            if (settings.get().streaming.applyContentSteering) {
                logger.warn('strictMode max: content steering is enabled, consider disabling to reduce extra traffic');
            }
        }

        return {
            mpd: extended['start']['mpd'],
            baseUri: extended['start']['base_uri'],
        };
    }

    /**
     * Reject a parsed manifest that turned out to be dynamic (live).
     *
     * Called by ManifestLoader once DashParser has run, rather than scanned
     * out of the MPD string during validation. `@type` is an XML attribute,
     * and `type='dynamic'` and `type = "dynamic"` are both well formed, so
     * any substring scan has false negatives. Reading the parsed value is
     * also the only way Dodge and dash.js cannot disagree about whether
     * the stream is live.
     *
     * Live content keeps adding segments that have no cycle in the fixed
     * cycle array, so the module has nothing to run and nothing to partially
     * degrade to. This is fatal regardless of `dodge.strictMode`, the same
     * way an unresolvable quality override is.
     *
     * @param {Object} manifest - Manifest as parsed by DashParser.
     * @param {string} [url] - Original request URL, for the error message.
     * @returns {boolean} True when rejected and manifest loading must stop.
     */
    function rejectIfDynamic(manifest, url) {
        if (!manifest || manifest.type !== DashConstants.DYNAMIC) {
            return false;
        }

        logger.error('Extended manifest at ' + (url || '(unknown URL)') +
            ' embeds a dynamic (live) MPD, which has no cycles for the segments it will add; blocking playback');

        // Drop what was registered before the parse, so a later load cannot
        // pick up a defense belonging to a manifest that was refused.
        defenseRegistry.reset();

        eventBus.trigger(events.INTERNAL_MANIFEST_LOADED, {
            manifest: null,
            error: new DashJSError(
                DodgeErrors.DODGE_DYNAMIC_MANIFEST_ERROR_CODE,
                DodgeErrors.DODGE_DYNAMIC_MANIFEST_ERROR_MESSAGE + (url || '')
            )
        });
        return true;
    }

    /**
     * Reason a representation's byte ranges have to be discovered at runtime,
     * or null when the MPD pins them.
     *
     * Mirrors `DashManifestModel._deriveSegmentInfo` plus the two guards that
     * decide whether `SegmentBaseLoader` runs: `Representation.hasInitialization()`
     * and `hasSegments()`. ObjectIron has already pushed an AdaptationSet- or
     * Period-level `SegmentBase` down onto each representation by this point,
     * so reading the representation alone is correct.
     *
     * @param {Object} representation - Parsed Representation node.
     * @returns {string|null} Human-readable reason, or null.
     */
    function _rangeDiscoveryReason(representation) {
        let segmentInfo = null;
        let isByteRange = false;

        if (representation.hasOwnProperty(DashConstants.SEGMENT_BASE)) {
            segmentInfo = representation[DashConstants.SEGMENT_BASE];
            isByteRange = true;
        } else if (representation.hasOwnProperty(DashConstants.SEGMENT_LIST)) {
            segmentInfo = representation[DashConstants.SEGMENT_LIST];
        } else if (representation.hasOwnProperty(DashConstants.SEGMENT_TEMPLATE)) {
            segmentInfo = representation[DashConstants.SEGMENT_TEMPLATE];
        } else {
            // No segment info at all: the BaseURL is a single file and both the
            // init range and the index are probed for.
            isByteRange = true;
        }

        const initialization = segmentInfo ? segmentInfo[DashConstants.INITIALIZATION] : null;
        const hasInitialization = !!segmentInfo && (
            segmentInfo.hasOwnProperty(DashConstants.INITIALIZATION_MINUS) ||
            (!!initialization && (initialization.hasOwnProperty(DashConstants.SOURCE_URL) ||
                initialization.hasOwnProperty(DashConstants.RANGE))));

        const reasons = [];
        if (!hasInitialization) {
            reasons.push('no initialization range');
        }
        if (isByteRange && !(segmentInfo && segmentInfo.hasOwnProperty(DashConstants.INDEX_RANGE))) {
            reasons.push('no index range');
        }

        return reasons.length > 0 ? reasons.join(' and ') : null;
    }

    /**
     * Report representations whose byte ranges dash.js has to discover by
     * probing the media file, and reject them under strict mode 'max'.
     *
     * When an MPD does not pin `Initialization@range`, `SegmentBaseLoader`
     * fetches bytes 0-1500, then 0-3000, then 0-4500, and so on until it finds
     * `moov`. When it does not pin `SegmentBase@indexRange`, a comparable walk
     * runs for `sidx`, this time with start offsets taken from the file's own
     * box layout. Either way, the request sequence is a function of where
     * those boxes sit in that particular file.
     *
     * The requests themselves are padded, since SegmentBaseLoader builds its
     * loader through FactoryMaker and so inherits the Dodge loader overrides.
     * What leaks is their number, and for the sidx walk their byte ranges. None
     * of it is under cycle control: Defense designers should publish explicit
     * ranges, which reduces this to one fetch per representation with a
     * range that is already part of the anonymity set.
     *
     * Called by ManifestLoader after DashParser has run, because these are
     * nested XML elements and attributes that no substring scan reads reliably.
     *
     * @param {Object} manifest - Manifest as parsed by DashParser.
     * @param {string} [url] - Original request URL, for the error message.
     * @returns {boolean} True when rejected and manifest loading must stop.
     */
    function rejectIfRangeDiscovery(manifest, url) {
        const strictMode = getStrictMode();
        if (strictMode === DodgeConstants.STRICT_MODE.NONE) {
            return false;
        }

        const affected = [];
        const periods = (manifest && manifest[DashConstants.PERIOD]) || [];
        for (let p = 0; p < periods.length; p++) {
            const adaptations = periods[p][DashConstants.ADAPTATION_SET] || [];
            for (let a = 0; a < adaptations.length; a++) {
                const representations = adaptations[a][DashConstants.REPRESENTATION] || [];
                for (let r = 0; r < representations.length; r++) {
                    const reason = _rangeDiscoveryReason(representations[r]);
                    if (reason) {
                        affected.push((representations[r].id || '(no id)') + ': ' + reason);
                    }
                }
            }
        }

        if (affected.length === 0) {
            return false;
        }

        const detail = 'representations whose byte ranges dash.js must discover by probing the media file - ' +
            affected.join(', ') + ' - producing a request sequence that follows the file layout and is outside cycle control';

        if (strictMode === DodgeConstants.STRICT_MODE.MAX) {
            logger.error('Extended manifest contains ' + detail + ', rejected by strict mode max');
            _triggerStrictModeError(url);
            return true;
        }

        logger.warn('Extended manifest contains ' + detail +
            ', publish explicit Initialization@range and SegmentBase@indexRange to remove it!');
        return false;
    }

    /**
     * Every gate that has to run on the parsed manifest in one call.
     *
     * `ManifestLoader` invokes this immediately after `parser.parse(data)` and
     * aborts the load when it returns true.
     *
     * @param {Object} manifest - Manifest as parsed by DashParser.
     * @param {string} [url] - Original request URL, for the error message.
     * @returns {boolean} True when a gate rejected it and loading must stop.
     */
    function rejectParsedManifest(manifest, url) {
        // Warn-only inspections run first so they are reported even when a gate
        // below rejects the manifest.
        _warnAboutSideChannels(manifest);

        return rejectIfDynamic(manifest, url) ||
            rejectIfRangeDiscovery(manifest, url) ||
            rejectIfUnshapedTracks(manifest, url);
    }

    function _triggerStrictModeError(url) {
        logger.error('Dodge strict mode is enabled and no valid extended manifest at ' + (url || '(unknown URL)') + ', blocking playback');
        eventBus.trigger(events.INTERNAL_MANIFEST_LOADED, {
            manifest: null,
            error: new DashJSError(
                DodgeErrors.DODGE_STRICT_MODE_ERROR_CODE,
                DodgeErrors.DODGE_STRICT_MODE_ERROR_MESSAGE + (url || '')
            )
        });
    }

    // Elements DASH allows an xlink:href on that dash.js actually resolves.
    // XlinkController walks exactly these three; anything else in the document
    // is never fetched, so flagging it would be a false positive.
    const XLINK_HOSTS = [DashConstants.PERIOD, DashConstants.ADAPTATION_SET, DashConstants.EVENT_STREAM];
    const XLINK_HREF = 'xlink:href';

    /**
     * Walk every AdaptationSet of a parsed manifest.
     *
     * @param {Object} manifest - Manifest as parsed by DashParser.
     * @param {function(Object, Object, number): void} fn - Receives the
     *        adaptation, its period, and the period index.
     */
    function _forEachAdaptation(manifest, fn) {
        const periods = (manifest && manifest[DashConstants.PERIOD]) || [];
        for (let p = 0; p < periods.length; p++) {
            const adaptations = periods[p][DashConstants.ADAPTATION_SET] || [];
            for (let a = 0; a < adaptations.length; a++) {
                fn(adaptations[a], periods[p], p);
            }
        }
    }

    function _describeAdaptation(adaptation, periodIndex) {
        const reps = adaptation[DashConstants.REPRESENTATION] || [];
        const ids = reps.map(r => r.id || '(no id)').join('/');
        return 'period ' + periodIndex + (ids ? ' representation ' + ids : '');
    }

    /**
     * Thumbnail tracks, which ThumbnailTracks fetches through its own loader,
     * outside DashHandler and outside the cycle plan.
     *
     * Uses dash.js's own image classification rather than scanning for the
     * scheme URI, so what is flagged is exactly what the player would treat as
     * a thumbnail track.
     */
    function _findThumbnailTracks(manifest) {
        const found = [];
        _forEachAdaptation(manifest, (adaptation, period, index) => {
            if (dashManifestModel.getIsTypeOf(adaptation, Constants.IMAGE)) {
                found.push(_describeAdaptation(adaptation, index));
            }
        });
        return found;
    }

    /**
     * Sidecar text tracks: a whole subtitle file fetched in one request that no
     * cycle describes.
     *
     * `getIsFragmented` is the same call dash.js uses to set
     * `mediaInfo.isFragmented`, so a fragmented TTML or WebVTT track - which is
     * segmented and therefore shaped like any other track - is not flagged.
     */
    function _findSidecarTextTracks(manifest) {
        const found = [];
        _forEachAdaptation(manifest, (adaptation, period, index) => {
            if (dashManifestModel.getIsText(adaptation) && !dashManifestModel.getIsFragmented(adaptation)) {
                found.push(_describeAdaptation(adaptation, index));
            }
        });
        return found;
    }

    /**
     * XLink references, which are resolved by fetching external XML before
     * playback starts.
     */
    function _findXlinkReferences(manifest) {
        const found = [];
        const periods = (manifest && manifest[DashConstants.PERIOD]) || [];
        for (let p = 0; p < periods.length; p++) {
            if (periods[p].hasOwnProperty(XLINK_HREF)) {
                found.push('period ' + p);
            }
            for (let h = 1; h < XLINK_HOSTS.length; h++) {
                const children = periods[p][XLINK_HOSTS[h]] || [];
                for (let c = 0; c < children.length; c++) {
                    if (children[c].hasOwnProperty(XLINK_HREF)) {
                        found.push('period ' + p + ' ' + XLINK_HOSTS[h]);
                    }
                }
            }
        }
        return found;
    }

    // MPD event schemes that make dash.js issue a request. EventController fires
    // a GET to a URL carried in the event payload for the callback scheme, and
    // refetches the manifest for the reload scheme, both only at value 1; any
    // other value falls through to a plain event bus dispatch with no request.
    const NETWORK_EVENT_SCHEMES = ['urn:mpeg:dash:event:callback:2015', 'urn:mpeg:dash:event:2012'];
    const NETWORK_EVENT_VALUE = 1;

    function _isNetworkEventStream(stream) {
        return NETWORK_EVENT_SCHEMES.indexOf(stream.schemeIdUri) !== -1 &&
            stream.value == NETWORK_EVENT_VALUE; // jshint ignore:line
    }

    /**
     * Event streams that make dash.js fetch something at a content-relative
     * time the cycle plan does not describe. The request is padded, since
     * EventController builds its loader in the same context, but its existence,
     * timing, and destination are not covered, and a callback URL is per-title
     * by construction.
     *
     * @param {Object} manifest - Manifest as parsed by DashParser.
     * @returns {Array<string>} Descriptions of what was found.
     */
    function _findNetworkEventStreams(manifest) {
        const found = [];
        const periods = (manifest && manifest[DashConstants.PERIOD]) || [];

        for (let p = 0; p < periods.length; p++) {
            const streams = periods[p][DashConstants.EVENT_STREAM] || [];
            for (let s = 0; s < streams.length; s++) {
                if (_isNetworkEventStream(streams[s])) {
                    found.push('period ' + p + ' EventStream ' + streams[s].schemeIdUri);
                }
            }

            const adaptations = periods[p][DashConstants.ADAPTATION_SET] || [];
            for (let a = 0; a < adaptations.length; a++) {
                const hosts = [adaptations[a]].concat(adaptations[a][DashConstants.REPRESENTATION] || []);
                for (let h = 0; h < hosts.length; h++) {
                    const inband = hosts[h][DashConstants.INBAND_EVENT_STREAM] || [];
                    for (let i = 0; i < inband.length; i++) {
                        if (_isNetworkEventStream(inband[i])) {
                            found.push('period ' + p + ' InbandEventStream ' + inband[i].schemeIdUri);
                        }
                    }
                }
            }
        }

        return found;
    }

    /**
     * ContentProtection anywhere in the manifest. DRM is allowed in every mode;
     * license traffic is simply not something the cycle plan covers.
     */
    function _hasContentProtection(manifest) {
        if (!manifest) {
            return false;
        }
        const periods = manifest[DashConstants.PERIOD] || [];
        for (let p = 0; p < periods.length; p++) {
            if ((periods[p][DashConstants.CONTENT_PROTECTION] || []).length > 0) {
                return true;
            }
            const adaptations = periods[p][DashConstants.ADAPTATION_SET] || [];
            for (let a = 0; a < adaptations.length; a++) {
                if ((adaptations[a][DashConstants.CONTENT_PROTECTION] || []).length > 0) {
                    return true;
                }
                const reps = adaptations[a][DashConstants.REPRESENTATION] || [];
                for (let r = 0; r < reps.length; r++) {
                    if ((reps[r][DashConstants.CONTENT_PROTECTION] || []).length > 0) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    function _hasContentSteering(manifest) {
        return !!manifest && (manifest[DashConstants.CONTENT_STEERING] || []).length > 0;
    }

    function _hasDvbReporting(manifest) {
        const metrics = (manifest && manifest[DashConstants.METRICS]) || [];
        return metrics.some(metric => (metric[DashConstants.REPORTING] || []).length > 0);
    }

    /**
     * Channels that emit their own requests but go to platform-wide endpoints,
     * so they are unlikely to identify the content on their own. Warned in every
     * mode except none, never a rejection.
     *
     * @param {Object} manifest - Manifest as parsed by DashParser.
     */
    function _warnAboutSideChannels(manifest) {
        if (getStrictMode() === DodgeConstants.STRICT_MODE.NONE) {
            return;
        }

        if (_hasContentProtection(manifest)) {
            logger.warn('Extended manifest contains DRM-protected content, which has not been tested with defenses, verify that license request patterns do not undermine the defense');
        }
        if (_hasContentSteering(manifest)) {
            logger.warn('Extended manifest contains ContentSteering - steering requests go to a platform-wide endpoint and are unlikely to aid passive fingerprinting, but verify');
        }
        if (_hasDvbReporting(manifest)) {
            logger.warn('Extended manifest contains DVB Reporting - reporting requests go to a platform-wide endpoint and are unlikely to aid passive fingerprinting, but verify');
        }
    }

    /**
     * Report tracks and references that fetch bytes outside the cycle plan, and
     * reject them under strict mode 'max'.
     *
     * Thumbnail tracks are fetched by ThumbnailTracks through its own loader,
     * sidecar text is one unshaped request for a whole subtitle file, XLink
     * resolution fetches external XML before playback starts, and callback or
     * reload event streams fire a request at a content-relative time chosen by
     * the manifest author. None of them passes through DashHandler, so no cycle
     * describes them.
     *
     * Called after DashParser has run. These are nested elements and namespaced
     * attributes; reading the parsed tree is the only way to tell a fragmented
     * text track from a sidecar one, or an xlink:href attribute from the same
     * characters sitting in an element's text.
     *
     * Detecting XLink here is still early enough to stop the fetch. ManifestLoader
     * parses, then runs this gate, and only afterwards calls
     * xlinkController.resolveManifestOnLoad() - the one entry point to xlink
     * fetching, with a single call site. A 'max' rejection returns before it, so
     * no external XML is requested.
     *
     * @param {Object} manifest - Manifest as parsed by DashParser.
     * @param {string} [url] - Original request URL, for the error message.
     * @returns {boolean} True when rejected and manifest loading must stop.
     */
    function rejectIfUnshapedTracks(manifest, url) {
        const strictMode = getStrictMode();
        if (strictMode === DodgeConstants.STRICT_MODE.NONE) {
            return false;
        }

        const findings = [];
        const thumbnails = _findThumbnailTracks(manifest);
        if (thumbnails.length > 0) {
            findings.push('thumbnail tracks (' + thumbnails.join(', ') + ')');
        }
        const text = _findSidecarTextTracks(manifest);
        if (text.length > 0) {
            findings.push('non-fragmented text tracks (' + text.join(', ') + ')');
        }
        const xlink = _findXlinkReferences(manifest);
        if (xlink.length > 0) {
            findings.push('XLink references (' + xlink.join(', ') + ')');
        }
        const events = _findNetworkEventStreams(manifest);
        if (events.length > 0) {
            findings.push('event streams with network side effects (' + events.join(', ') + ')');
        }

        if (findings.length === 0) {
            return false;
        }

        const detail = findings.join(' and ') + ' that bypass Dodge defense';
        if (strictMode === DodgeConstants.STRICT_MODE.MAX) {
            logger.error('Extended manifest contains ' + detail + ', rejected by strict mode max');
            _triggerStrictModeError(url);
            return true;
        }

        logger.warn('Extended manifest contains ' + detail +
            ', verify that their sizes do not create a distinguishing traffic pattern!');
        return false;
    }

    /**
     * Diagnostic warning when a NEED_KEY event fires during defended
     * playback. DRM is allowed in all modes but the defense designer
     * should be aware.
     */
    function _onNeedKey() {
        if (!defenseRegistry.hasContent()) {
            return;
        }

        if (getStrictMode() !== DodgeConstants.STRICT_MODE.NONE) {
            logger.warn('DRM key request detected during defended playback, DRM has not been tested with defenses');
        }
    }

    /**
     * Diagnostic warning when a DRM key session is created during
     * defended playback. DRM is allowed in all modes but the defense
     * designer should be aware.
     */
    function _onKeySessionCreated(e) {
        if (e.error || !defenseRegistry.hasContent()) {
            return;
        }

        if (getStrictMode() !== DodgeConstants.STRICT_MODE.NONE) {
            logger.warn('DRM key session created during defended playback, license requests may leak content-identifying information');
        }
    }

    /**
     * Get the number of partial responses, pending init events, and pending
     * media events for a stream.
     */
    function getStreamStats(streamId) {
        const state = _getStreamState(streamId);
        const { partialSegments, pendingInit, pendingMedia } = state;

        return {
            partialSegments: partialSegments.length,
            pendingInit: pendingInit.length,
            pendingMedia: pendingMedia.length
        }
    }

    /**
     * True when at least one active stream processor is running a Dodge
     * defense. False when the module is loaded but no extended manifest is
     * active, or when all stream processors fell back to vanilla DASH.
     * @returns {boolean}
     */
    function isDodgeActive() {
        if (!streamController) { return false; }
        return streamController.getActiveStreamProcessors()
            .some(sp => sp.getDashHandler() && sp.getDashHandler().getIsDefended());
    }

    /**
     * True when Dodge playback has entered the trailing padding phase
     * (at least one active stream processor is currently trailing).
     * @returns {boolean}
     */
    function isDodgeTrailing() {
        if (!streamController) { return false; }
        return streamController.getActiveStreamProcessors()
            .some(sp => sp.getDashHandler() && sp.getDashHandler().getIsTrailing());
    }

    /**
     * Append data cycles to a progressive stream at runtime.
     * Delegates to DefenseRegistry.appendDataCycles. The append is atomic and
     * self-contained: a rejected batch changes nothing.
     * @param {string} label - Stream label (representation ID).
     * @param {number|null} periodIndex - Optional period index for multi-period MPDs.
     * @param {Array} cycles - Data cycles to append.
     * @returns {boolean} True if the batch was accepted.
     */
    function appendDataCycles(label, periodIndex, cycles) {
        return defenseRegistry.appendDataCycles(label, periodIndex, cycles);
    }

    /**
     * Finalize a progressive stream: append optional trailing
     * padding cycles and clear the progressive flag so the override finishes
     * (rather than stalls) when it runs off the end of the data. Delegates to
     * DefenseRegistry.finalizeStream.
     * @param {string} label - Stream label (representation ID).
     * @param {number|null} periodIndex - Optional period index for multi-period MPDs.
     * @param {Array} [paddingCycles] - Trailing padding cycles to append.
     * @returns {boolean} True if the stream was finalized.
     */
    function finalizeStream(label, periodIndex, paddingCycles) {
        return defenseRegistry.finalizeStream(label, periodIndex, paddingCycles);
    }

    function reset() {
        eventBus.off(events.FRAGMENT_LOADING_COMPLETED, _onFragmentLoadingCompleted, instance);
        eventBus.off(events.INIT_FRAGMENT_PARTIAL, _onPartialSegment, instance);
        eventBus.off(events.MEDIA_FRAGMENT_PARTIAL, _onPartialSegment, instance);
        eventBus.off(events.PADDING_LOADED, _onPaddingLoaded, instance);
        if (events.NEED_KEY) {
            eventBus.off(events.NEED_KEY, _onNeedKey, instance);
        }
        if (events.KEY_SESSION_CREATED) {
            eventBus.off(events.KEY_SESSION_CREATED, _onKeySessionCreated, instance);
        }
        defenseRegistry.reset();
        streamState.clear();
    }

    // ************************************************************************
    // SCHEDULING AND DODGE EVENTS
    // ************************************************************************

    function _getScheduleWait() {
        const base = resolveNumericSetting(settings, 'scheduleWaitBase');
        if (!base.valid && !warnedScheduleBase) {
            logger.warn(base.message);
            warnedScheduleBase = true;
        }
        const random = resolveNumericSetting(settings, 'scheduleWaitRandom');
        if (!random.valid && !warnedScheduleRandom) {
            logger.warn(random.message);
            warnedScheduleRandom = true;
        }

        return base.value + Math.round(Math.random() * random.value);
    }

    function _getStreamProcessor(mediaType) {
        if (!streamController) {
            return null;
        }
        if (!mediaType) {
            return null;
        }
        return streamController.getActiveStreamProcessors().find(sp => sp.getType() === mediaType) || null;
    }

    function _setQualityCheck(checkQuality, mediaType) {
        const sp = _getStreamProcessor(mediaType);
        if (sp) {
            const sc = sp.getScheduleController();
            if (sc) {
                sc.setShouldCheckPlaybackQuality(checkQuality);
            }
        }
    }

    function _schedule(checkQuality, delay, mediaType) {
        const sp = _getStreamProcessor(mediaType);
        if (sp) {
            const sc = sp.getScheduleController();
            if (sc) {
                sc.setShouldCheckPlaybackQuality(checkQuality);
                sc.startScheduleTimer(delay);
            }
        }
    }

    // Partial segment download: start schedule timer
    function _onPartialSegment(e) {
        if (!e.suppress) {
            // No quality switches after partial segment downloads
            _schedule(false, _getScheduleWait(), e.mediaType);
        }
    }

    // Padding loaded: schedule and update mock buffers
    function _onPaddingLoaded(e) {
        if (!e.suppress) {
            _schedule(e.bufferFlag || false, _getScheduleWait(), e.mediaType);
        }

        // Route to buffer controllers for mock buffer management
        const sp = _getStreamProcessor(e.mediaType);
        if (sp) {
            const bc = sp.getBufferController();
            if (bc && bc.onPaddingLoaded) {
                bc.onPaddingLoaded(e);
            }
        }
    }

    // ************************************************************************
    // PARTIAL SEGMENT COMBINATION
    // ************************************************************************

    function _getStreamState(streamId) {
        if (!streamState.has(streamId)) {
            streamState.set(streamId, {
                partialSegments: [],
                pendingInit: [],
                pendingMedia: [],
            });
        }
        return streamState.get(streamId);
    }

    function _isBufferActive(buffer) {
        if (Array.isArray(buffer)) {
            return buffer.length > 0;
        }
        return !!buffer;
    }

    // Orders a flush set for release. Init events carry index NaN and always
    // lead, since the SourceBuffer needs the init segment before any media that
    // depends on it. Array.prototype.sort is stable, so entries that tie keep
    // completion order.
    function _releaseOrder(a, b) {
        const aInit = isNaN(a.index);
        const bInit = isNaN(b.index);
        if (aInit !== bInit) {
            return aInit ? -1 : 1;
        }
        return aInit ? 0 : a.index - b.index;
    }

    function _onFragmentLoadingCompleted(e) {
        // Event propagation may have been stopped.
        if (!e.sender) {
            return;
        }

        const request = e.request;
        const bytes = e.response;
        const isInit = request.isInitializationRequest();
        const strInfo = request.representation.mediaInfo.streamInfo;

        // If no Dodge-specific fields are set, this is a vanilla request.
        // Let FragmentController handle it normally.
        if (request.full === undefined && request.padding === undefined) {
            return;
        }

        if (e.error) {
            // Stall permanently: HTTPLoader already exhausted its retries, so the
            // segment is genuinely unavailable and rescheduling would just fail
            // again. The defense runs correctly or not at all.
            //
            // Nulling the sender stops FragmentController, but not everything reads
            // that field. StreamProcessor._onFragmentLoadingCompleted does not, and
            // it gates _handleFragmentLoadingError on
            // `e.error && e.request.serviceLocation`.
            // So drop the service location too.
            e.sender = null;
            e.request.serviceLocation = null;
            logger.error(request.mediaType + ' download failed after all retries; stalling to preserve defense pattern. URL: ' + request.url);
            return;
        }

        // Stop propagation; this request will be handled entirely by Dodge.
        e.sender = null;

        if (!bytes || !strInfo) {
            logger.warn('No ' + request.mediaType + ' bytes to push or stream is inactive.');
            return;
        }

        // An origin that ignores the Range header answers a range request with
        // the whole resource and a 200, which HTTPLoader accepts as success (it
        // tests for 2xx, never for 206, and reads no Content-Range). Assembling
        // from that body overruns the buffer sized from the declared range and
        // throws out of this handler, which EventBus does not guard.
        //
        // The crash is the smaller half. If ranges are not being served, every
        // cycle fetches the whole segment, so the defense is broken. Stall rather
        // than play on: a defense that cannot run correctly must not run at all.
        const requested = _parseRequestRange(request);
        const requestedLength = requested.end - requested.start + 1;
        if (requested.end >= requested.start && bytes.byteLength > requestedLength) {
            logger.error(request.mediaType + ' response is ' + bytes.byteLength + ' bytes for a ' +
                requestedLength + '-byte range request; the origin ignored the Range header, so cycles are ' +
                'fetching whole segments and the defense is not running. Stalling. URL: ' + request.url);
            return;
        }

        const state = _getStreamState(strInfo.id);
        const { partialSegments, pendingInit, pendingMedia } = state;

        // Check if any pending events should be fired first.
        // Pending events are stored in reverse chronological order.
        let primaryEvent = null;
        let secondaryEvents = [];

        // If the buffer flag is active, flush pendingMedia and pendingInit and
        // populate secondaryEvents with the pending events.
        // When buffer is an array of segment indices (selective buffer), only
        // pending media events whose index is in the array are flushed; others
        // stay queued. Pending init events are only flushed for boolean true.
        if (_isBufferActive(request.buffer)) {
            const selectiveIndices = Array.isArray(request.buffer) ? new Set(request.buffer) : null;

            // [data segments] Flush pending media events for same
            // stream and mediaType. Use the home representation ID for
            // matching: with quality overrides, consecutive cycles may
            // carry different representation IDs, but all belong to the
            // same defended stream and should be flushed together.
            const homeRepId = request.homeRepresentationId || request.representation.id;
            for (let i = pendingMedia.length - 1; i >= 0; i--) {
                const event = pendingMedia[i];
                if (event.streamId == strInfo.id && event.mediaType == request.mediaType) {
                    const eventHomeRepId = event.homeRepresentationId || event.representationId;
                    if (eventHomeRepId == homeRepId) {
                        if (!selectiveIndices || selectiveIndices.has(event.index)) {
                            secondaryEvents.push(event);
                            pendingMedia.splice(i, 1);
                        }
                    } else {
                        pendingMedia.splice(i, 1);
                    }
                }
            }

            // [init segments] Flush pending init events for same
            // stream and mediaType (boolean buffer only)
            if (!selectiveIndices) {
                for (let i = pendingInit.length - 1; i >= 0; i--) {
                    const event = pendingInit[i];
                    if (event.streamId == strInfo.id && event.mediaType == request.mediaType) {
                        secondaryEvents.push(event);
                        pendingInit.splice(i, 1);
                    }
                }
            }
        }

        // Accumulate partial responses (skip padding).
        if (!request.padding) {
            partialSegments.push({
                request: request,
                response: new Uint8Array(bytes)
            });
        }

        // If this is a full segment or completes a sequence of partial
        // segment downloads, combine partial responses and route. If the
        // buffer flag is set, a fragment loaded event is set as the primary
        // event. Otherwise, queue a loaded event + propagate a partial event.
        // 
        // If this is a partial segment download that does not complete a
        // sequence, just propagate a partial event. If it's a padding
        // download, propagate a padding loaded event.
        if (request.full) {
            const response = _concatPartialSegments(partialSegments, request.index, request.representation.id, request.mediaType);
            const chunk = _createDataChunk(response, request, strInfo.id, true);

            // Buffer the current segment when buffer is boolean true, or when
            // buffer is an array that includes this segment's index.
            const bufferCurrent = request.buffer === true
                || (Array.isArray(request.buffer) && request.buffer.indexOf(request.index) !== -1);
            if (bufferCurrent) {
                primaryEvent = {
                    chunk: chunk,
                    event: isInit ? events.INIT_FRAGMENT_LOADED : events.MEDIA_FRAGMENT_LOADED,
                    index: isInit ? NaN : request.index
                };
            } else {
                if (isInit) {
                    pendingInit.push({
                        chunk: chunk,
                        streamId: strInfo.id,
                        mediaType: request.mediaType,
                        representationId: request.representation.id,
                        event: events.INIT_FRAGMENT_LOADED,
                        index: NaN,
                        request: request
                    });
                } else {
                    pendingMedia.push({
                        chunk: chunk,
                        streamId: strInfo.id,
                        mediaType: request.mediaType,
                        representationId: request.representation.id,
                        homeRepresentationId: request.homeRepresentationId || null,
                        event: events.MEDIA_FRAGMENT_LOADED,
                        index: request.index,
                        request: request
                    });
                }
                primaryEvent = {
                    event: isInit ? events.INIT_FRAGMENT_PARTIAL : events.MEDIA_FRAGMENT_PARTIAL,
                    index: isInit ? NaN : request.index
                };
            }
        } else if (!request.padding) {
            primaryEvent = {
                event: isInit ? events.INIT_FRAGMENT_PARTIAL : events.MEDIA_FRAGMENT_PARTIAL,
                index: isInit ? NaN : request.index
            };
        } else {
            primaryEvent = {
                event: events.PADDING_LOADED,
                index: request.index
            };
        }

        // Determine whether quality checks should be enabled. Rules:
        //  - data fragment loaded with buffer = true or selective array: yes
        //  - padding with active buffer and at least one data secondary: yes
        //  - init fragment loaded: no
        //  - partial (init or data): no
        const hasDataSecondary = secondaryEvents.some(
            ev => ev.event === events.MEDIA_FRAGMENT_LOADED
        );
        let enableQualityCheck = false;
        if (primaryEvent.event === events.MEDIA_FRAGMENT_LOADED) {
            enableQualityCheck = _isBufferActive(request.buffer);
        } else if (primaryEvent.event === events.PADDING_LOADED) {
            enableQualityCheck = _isBufferActive(request.buffer) && hasDataSecondary;
        }

        // Release order is segment order, not download order. A defense may
        // download segment 3 before segment 2, but the SourceBuffer must still
        // see indices ascending, so the whole flush set is sorted before it is
        // fired. secondaryEvents was built by walking the pending queues
        // backwards, so reverse it to keep completion order for ties.
        //
        // One event is left unsuppressed, and it is fired last, because
        // it is what re-arms the ScheduleController through the vanilla
        // _onBytesAppended path. After sorting that is the highest index in the
        // set, which is not necessarily the cycle that carried the buffer flag.
        secondaryEvents.reverse();

        const primaryIsAppend = primaryEvent.event === events.INIT_FRAGMENT_LOADED
            || primaryEvent.event === events.MEDIA_FRAGMENT_LOADED;

        if (primaryIsAppend) {
            secondaryEvents.push({
                chunk: primaryEvent.chunk,
                event: primaryEvent.event,
                index: primaryEvent.index,
                request: request
            });
            _setQualityCheck(enableQualityCheck, request.mediaType);
        }
        secondaryEvents.sort(_releaseOrder);

        for (let i = 0; i < secondaryEvents.length; i++) {
            const event = secondaryEvents[i];
            const isLast = primaryIsAppend && i === secondaryEvents.length - 1;
            eventBus.trigger(event.event,
                {
                    chunk: event.chunk,
                    request: isLast ? event.request : undefined,
                    suppress: !isLast
                },
                { streamId: strInfo.id, mediaType: request.mediaType }
            );
        }

        if (primaryIsAppend) {
            // Alternate-representation init segments are cached by the
            // DodgeBufferControllerOverride and never reach the SourceBuffer,
            // so BufferController's normal _onAppended path never fires
            // BYTES_APPENDED_END_FRAGMENT and the ScheduleController never
            // re-arms its timer. Kick the schedule explicitly here so the
            // next init/media cycle is requested.
            if (primaryEvent.event === events.INIT_FRAGMENT_LOADED && request.homeRepresentationId) {
                _schedule(false, _getScheduleWait(), request.mediaType);
            }

        } else {
            eventBus.trigger(primaryEvent.event,
                {
                    index: primaryEvent.index,
                    representation: request.representation,
                    quality: request.quality,
                    byteLength: bytes.byteLength,
                    trail: request.trail,
                    buffer: request.buffer === true && !hasDataSecondary,
                    bufferFlag: enableQualityCheck,
                    suppress: false
                },
                { streamId: strInfo.id, mediaType: request.mediaType }
            );
        }
    }

    /**
     * Byte range a request asked for, using the same precedence the assembler
     * uses: `originalRange` from the MPD first, then the cycle's `range`,
     * which overrides it. An omitted start bound means 0 and an omitted end
     * bound means "not pinned", matching the range semantics DefenseRegistry
     * documents ("-855" is 0 through 855, "44-" runs to the end).
     *
     * @param {Object} request - The FragmentRequest to read.
     * @returns {{start: number, end: number}} Bounds, with `end` of -1 when
     *          the request did not pin one.
     */
    function _parseRequestRange(request) {
        let start = 0;
        let end = -1;

        const sources = [request.originalRange, request.range];
        for (let i = 0; i < sources.length; i++) {
            if (!sources[i]) {
                continue;
            }
            const tokens = String(sources[i]).split('-');
            const s = parseInt(tokens[0], 10);
            const e = parseInt(tokens[1], 10);
            if (!isNaN(s)) { start = s; }
            if (!isNaN(e)) { end = e; }
        }

        return { start, end };
    }

    // Combine partial responses for a given segment index / representation and
    // remove them from the partialSegments array.
    function _concatPartialSegments(partialSegments, index, representationId, mediaType) {
        logger.debug('Concat partial responses for segment with index ' + index + ', representation id ' + representationId);

        let pieces = [];
        let minRangeStart = Number.MAX_SAFE_INTEGER;
        let maxRangeEnd = 0;

        for (let i = partialSegments.length - 1; i >= 0; i--) {
            const piece = partialSegments[i];

            if ((index == piece.request.index || (isNaN(index) && isNaN(piece.request.index))) &&
                mediaType == piece.request.mediaType &&
                representationId == piece.request.representation.id) {

                const parsedRange = _parseRequestRange(piece.request);
                const rangeStart = parsedRange.start;
                let rangeEnd = parsedRange.end;

                if (rangeEnd < 0) {
                    rangeEnd = rangeStart + piece.response.byteLength - 1;
                }

                minRangeStart = Math.min(minRangeStart, rangeStart);
                maxRangeEnd = Math.max(maxRangeEnd, rangeEnd);
                pieces.push({ piece, rangeStart });

                partialSegments.splice(i, 1);
            }
        }

        const totalSize = maxRangeEnd - minRangeStart + 1;
        logger.debug('Found ' + pieces.length + ' partial responses (' + totalSize + ' bytes) for segment with index ' + index);

        const result = new Uint8Array(totalSize);
        for (let i = 0; i < pieces.length; i++) {
            const { piece, rangeStart } = pieces[i];
            result.set(piece.response, rangeStart - minRangeStart);
        }

        return result;
    }

    function _createDataChunk(bytes, request, streamId, endFragment) {
        const chunk = new DataChunk();
        chunk.streamId = streamId;
        chunk.segmentType = request.type;
        chunk.start = request.startTime;
        chunk.duration = request.duration;
        chunk.end = chunk.start + chunk.duration;
        chunk.bytes = bytes;
        chunk.index = request.index;
        chunk.quality = request.quality;
        chunk.representation = request.representation;
        chunk.homeRepresentationId = request.homeRepresentationId || null;
        chunk.endFragment = endFragment;
        return chunk;
    }

    function _applyAbrRules() {
        const rules = {};

        Object.values(Constants.QUALITY_SWITCH_RULES).forEach(name => {
            const key = name.charAt(0).toLowerCase() + name.slice(1);
            if (!SUPPORTED_QUALITY_SWITCH_RULES.has(key)) {
                rules[key] = { active: false };
            }
        });

        Object.values(Constants.ABANDON_FRAGMENT_RULES).forEach(name => {
            const key = name.charAt(0).toLowerCase() + name.slice(1);
            if (!SUPPORTED_ABANDON_FRAGMENT_RULES.has(key)) {
                rules[key] = { active: false };
            }
        });

        mediaPlayer.updateSettings({ streaming: { abr: { rules } } });
    }

    instance = {
        registerExtensions,
        registerEvents,
        tryProcessExtendedManifest,
        rejectParsedManifest,
        rejectIfDynamic,
        rejectIfRangeDiscovery,
        rejectIfUnshapedTracks,
        getStreamStats,
        isDodgeActive,
        isDodgeTrailing,
        appendDataCycles,
        finalizeStream,
        reset,
    };

    setup();

    return instance;
}

DodgeHandler.__dashjs_factory_name = 'DodgeHandler';
const factory = FactoryMaker.getClassFactory(DodgeHandler);
factory.events = DodgeEvents;
factory.errors = DodgeErrors;
export default factory;
