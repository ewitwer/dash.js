import DodgeBufferControllerOverride from '../../../../src/dodge/overrides/DodgeBufferControllerOverride.js';
import Debug from '../../../../src/core/Debug.js';
import EventBus from '../../../../src/core/EventBus.js';
import Settings from '../../../../src/core/Settings.js';
import MediaPlayerEvents from '../../../../src/streaming/MediaPlayerEvents.js';
import { createDodgeContext, releaseDodgeContexts } from '../../helpers/DodgeContexts.js';

import sinon from 'sinon';
import { expect } from 'chai';

// ************************************************************************
// TESTS
// ************************************************************************

describe('DodgeBufferControllerOverride', function () {
    let context, override, mockParent, dashHandler, playbackController, capabilities;

    beforeEach(function () {
        context = createDodgeContext();

        // Debug must be present because the override calls Debug(context).getInstance()
        Debug(context).getInstance();

        mockParent = {
            setMockBuffer: sinon.stub(),
            updateBufferLevel: sinon.stub(),
            reset: sinon.stub(),
            _onInitFragmentLoaded: sinon.stub(),
            _onMediaFragmentLoaded: sinon.stub(),
            appendToBuffer: sinon.stub(),
            changeType: sinon.stub().resolves(),
            prepareForDefaultQualitySwitch: sinon.stub().resolves(),
            getInitChunkFromCache: sinon.stub().returns(null),
            getType: sinon.stub().returns('video'),
        };

        dashHandler = {
            getIsTrailing: sinon.stub().returns(false),
        };

        playbackController = {
            getTimeSinceStreamEnd: sinon.stub().returns(0),
        };

        capabilities = {
            supportsChangeType: sinon.stub().returns(true),
        };

        override = DodgeBufferControllerOverride.call(
            { context, parent: mockParent, factory: {} },
            { dashHandler, playbackController, capabilities, settings: Settings(context).getInstance() }
        );
    });

    afterEach(function () {
        releaseDodgeContexts();
    });

    // onBufferCycleLoaded

    describe('onBufferCycleLoaded', function () {

        it('increments mockBuffer by (segmentDuration - actualDuration) and syncs to parent', function () {
            override.onBufferCycleLoaded({ representation: { segmentDuration: 4 }, actualDuration: 3.97 });
            expect(mockParent.setMockBuffer.calledOnce).to.be.true; // jshint ignore:line
            expect(mockParent.setMockBuffer.firstCall.args[0]).to.be.closeTo(0.03, 1e-9);
        });

        it('can produce a negative mockBuffer when actualDuration exceeds segmentDuration', function () {
            override.onBufferCycleLoaded({ representation: { segmentDuration: 4 }, actualDuration: 4.03 });
            expect(mockParent.setMockBuffer.firstCall.args[0]).to.be.closeTo(-0.03, 1e-9);
        });

        it('accumulates across multiple calls', function () {
            override.onBufferCycleLoaded({ representation: { segmentDuration: 4 }, actualDuration: 3.97 });
            override.onBufferCycleLoaded({ representation: { segmentDuration: 4 }, actualDuration: 3.97 });
            expect(mockParent.setMockBuffer.lastCall.args[0]).to.be.closeTo(0.06, 1e-9);
        });

        it('zero variance when actualDuration equals segmentDuration', function () {
            override.onBufferCycleLoaded({ representation: { segmentDuration: 4 }, actualDuration: 4 });
            expect(mockParent.setMockBuffer.calledOnceWith(0)).to.be.true; // jshint ignore:line
        });

        it('resets mockBuffer before accumulating when trailing was active', function () {
            // Enter trailing state
            dashHandler.getIsTrailing.returns(true);
            playbackController.getTimeSinceStreamEnd.returns(5);
            override.updateBufferLevel();
            mockParent.setMockBuffer.reset();

            // onBufferCycleLoaded should reset trailing state then accumulate
            override.onBufferCycleLoaded({ representation: { segmentDuration: 4 }, actualDuration: 3.9 });

            // First call resets to 0, second call sets accumulated value
            // After reset, mockBuffer = 0 + (4 - 3.9) = 0.1
            expect(mockParent.setMockBuffer.lastCall.args[0]).to.be.closeTo(0.1, 1e-9);
        });

        it('large negative variance is accepted', function () {
            override.onBufferCycleLoaded({ representation: { segmentDuration: 2 }, actualDuration: 5 });
            expect(mockParent.setMockBuffer.firstCall.args[0]).to.be.closeTo(-3, 1e-9);
        });

        it('large positive variance accumulates correctly', function () {
            override.onBufferCycleLoaded({ representation: { segmentDuration: 10 }, actualDuration: 3 });
            expect(mockParent.setMockBuffer.firstCall.args[0]).to.be.closeTo(7, 1e-9);
        });

    });

    // onPaddingLoaded

    describe('onPaddingLoaded', function () {

        it('e.trail = false, does not call parent.setMockBuffer()', function () {
            override.onPaddingLoaded({ trail: false, buffer: false, representation: { segmentDuration: 4 } });
            expect(mockParent.setMockBuffer.called).to.be.false; // jshint ignore:line
        });

        it('e.trail = true, e.buffer = false, does not increment mockBuffer', function () {
            override.onPaddingLoaded({ trail: true, buffer: false, representation: { segmentDuration: 4 } });
            expect(mockParent.setMockBuffer.called).to.be.false; // jshint ignore:line
        });

        it('e.trail = true, e.buffer = true, increments mockBuffer by segmentDuration and syncs to parent', function () {
            override.onPaddingLoaded({ trail: true, buffer: true, representation: { segmentDuration: 4 } });
            expect(mockParent.setMockBuffer.calledOnceWith(4)).to.be.true; // jshint ignore:line
        });

        it('accumulates mockBuffer across calls', function () {
            override.onPaddingLoaded({ trail: true, buffer: true, representation: { segmentDuration: 4 } });
            override.onPaddingLoaded({ trail: true, buffer: true, representation: { segmentDuration: 4 } });
            expect(mockParent.setMockBuffer.lastCall.args[0]).to.equal(8);
        });

        it('e.trail = false with non-zero lastTimeSinceStreamEnd, resets mockBuffer to 0', function () {
            // Build up trailing state via updateBufferLevel
            dashHandler.getIsTrailing.returns(true);
            playbackController.getTimeSinceStreamEnd.returns(5);
            override.updateBufferLevel(); // advances lastTimeSinceStreamEnd to 5
            mockParent.setMockBuffer.reset();

            // A non-trailing padding cycle should now trigger the reset
            override.onPaddingLoaded({ trail: false, buffer: false, representation: { segmentDuration: 4 } });
            expect(mockParent.setMockBuffer.calledOnceWith(0)).to.be.true; // jshint ignore:line
        });
    });

    // updateBufferLevel

    describe('updateBufferLevel', function () {

        it('when not trailing, delegates to parent.updateBufferLevel()', function () {
            dashHandler.getIsTrailing.returns(false);
            override.updateBufferLevel();
            expect(mockParent.setMockBuffer.called).to.be.false; // jshint ignore:line
            expect(mockParent.updateBufferLevel.calledOnce).to.be.true; // jshint ignore:line
        });

        it('when trailing, decrements mockBuffer by elapsed time and syncs to parent', function () {
            // Load 8s into mockBuffer via two trailing padding events
            override.onPaddingLoaded({ trail: true, buffer: true, representation: { segmentDuration: 4 } });
            override.onPaddingLoaded({ trail: true, buffer: true, representation: { segmentDuration: 4 } });
            mockParent.setMockBuffer.reset();

            dashHandler.getIsTrailing.returns(true);
            playbackController.getTimeSinceStreamEnd.returns(3);
            override.updateBufferLevel(); // diffInTime = 3; currentMockBuffer = 8 - 3 = 5

            expect(mockParent.setMockBuffer.calledOnceWith(5)).to.be.true; // jshint ignore:line
            expect(mockParent.updateBufferLevel.calledOnce).to.be.true; // jshint ignore:line
        });

        it('when trailing, clamps mockBuffer to 0 when elapsed time exceeds accumulated value', function () {
            override.onPaddingLoaded({ trail: true, buffer: true, representation: { segmentDuration: 4 } });
            mockParent.setMockBuffer.reset();

            dashHandler.getIsTrailing.returns(true);
            playbackController.getTimeSinceStreamEnd.returns(10); // more than the 4s in mockBuffer
            override.updateBufferLevel();

            expect(mockParent.setMockBuffer.calledOnceWith(0)).to.be.true; // jshint ignore:line
        });

        it('skips mock buffer logic when dashHandler is undefined, still calls parent', function () {
            // Create override without dashHandler
            const noDashOverride = DodgeBufferControllerOverride.call(
                { context, parent: mockParent, factory: {} },
                { dashHandler: undefined, playbackController, capabilities, settings: Settings(context).getInstance() }
            );
            mockParent.setMockBuffer.reset();
            mockParent.updateBufferLevel.reset();

            noDashOverride.updateBufferLevel();

            expect(mockParent.setMockBuffer.called).to.be.false; // jshint ignore:line
            expect(mockParent.updateBufferLevel.calledOnce).to.be.true; // jshint ignore:line
        });

        it('skips mock buffer logic when playbackController is undefined, still calls parent', function () {
            const noPbOverride = DodgeBufferControllerOverride.call(
                { context, parent: mockParent, factory: {} },
                { dashHandler, playbackController: undefined, capabilities }
            );
            mockParent.setMockBuffer.reset();
            mockParent.updateBufferLevel.reset();

            noPbOverride.updateBufferLevel();

            expect(mockParent.setMockBuffer.called).to.be.false; // jshint ignore:line
            expect(mockParent.updateBufferLevel.calledOnce).to.be.true; // jshint ignore:line
        });

        it('resets mockBuffer when exiting trailing phase', function () {
            // Enter trailing
            dashHandler.getIsTrailing.returns(true);
            playbackController.getTimeSinceStreamEnd.returns(2);
            override.onPaddingLoaded({ trail: true, buffer: true, representation: { segmentDuration: 4 } });
            override.updateBufferLevel();
            mockParent.setMockBuffer.reset();

            // Exit trailing
            dashHandler.getIsTrailing.returns(false);
            override.updateBufferLevel();

            expect(mockParent.setMockBuffer.calledOnceWith(0)).to.be.true; // jshint ignore:line
        });

        it('clamps delta to zero when timeSinceStreamEnd decreases', function () {
            // Enter trailing with time = 5
            override.onPaddingLoaded({ trail: true, buffer: true, representation: { segmentDuration: 8 } });
            dashHandler.getIsTrailing.returns(true);
            playbackController.getTimeSinceStreamEnd.returns(5);
            override.updateBufferLevel();
            mockParent.setMockBuffer.reset();

            // Time goes backwards to 3 (Math.max(0, 3-5) = 0)
            playbackController.getTimeSinceStreamEnd.returns(3);
            override.updateBufferLevel();

            // mockBuffer should not increase; delta clamped to 0
            // currentMockBuffer was 8 - 5 = 3 from first call
            expect(mockParent.setMockBuffer.lastCall.args[0]).to.be.closeTo(3, 1e-9);
        });
    });

    // reset

    describe('reset', function () {

        it('resets internal state and delegates to parent.reset()', function () {
            // Add some state first
            override.onPaddingLoaded({ trail: true, buffer: true, representation: { segmentDuration: 4 } });
            mockParent.setMockBuffer.reset();

            override.reset(false, false);

            expect(mockParent.reset.calledOnceWith(false, false)).to.be.true; // jshint ignore:line
            // After reset, a non-trailing updateBufferLevel should not call setMockBuffer
            dashHandler.getIsTrailing.returns(false);
            override.updateBufferLevel();
            expect(mockParent.setMockBuffer.called).to.be.false; // jshint ignore:line
        });

        it('resets mockBuffer to zero after accumulation', function () {
            override.onBufferCycleLoaded({ representation: { segmentDuration: 4 }, actualDuration: 3.5 });
            override.onPaddingLoaded({ trail: true, buffer: true, representation: { segmentDuration: 4 } });
            mockParent.setMockBuffer.reset();

            override.reset(false, false);

            // Verify by accumulating again - value should start from zero, not from prior state
            override.onBufferCycleLoaded({ representation: { segmentDuration: 4 }, actualDuration: 3.9 });
            expect(mockParent.setMockBuffer.lastCall.args[0]).to.be.closeTo(0.1, 1e-9);
        });
    });

    // _onMediaFragmentLoaded (init sandwich for quality overrides)

    describe('_onMediaFragmentLoaded', function () {

        it('appends non-override chunks through the parent appendToBuffer', async function () {
            const e = {
                chunk: { representation: { id: 'video_1000k' }, homeRepresentationId: null },
                request: {}
            };
            await override._onMediaFragmentLoaded(e);
            expect(mockParent.appendToBuffer.calledOnce).to.be.true; // jshint ignore:line
            expect(mockParent.appendToBuffer.firstCall.args[0]).to.equal(e.chunk);
            expect(mockParent.appendToBuffer.firstCall.args[1]).to.equal(e.request);
            expect(mockParent._onMediaFragmentLoaded.called).to.be.false; // jshint ignore:line
        });

        it('sandwiches quality override chunk with changeType() + init segments when both inits are cached', async function () {
            const alternateRep = { id: 'video_500k' };
            const homeRep = { id: 'video_1000k' };
            const alternateInit = { representation: alternateRep, bytes: new Uint8Array(10) };
            const homeInit = { representation: homeRep, bytes: new Uint8Array(20) };
            mockParent.getInitChunkFromCache.withArgs('video_500k').returns(alternateInit);
            mockParent.getInitChunkFromCache.withArgs('video_1000k').returns(homeInit);

            const chunk = {
                representation: alternateRep,
                homeRepresentationId: 'video_1000k'
            };
            const request = {};
            await override._onMediaFragmentLoaded({ chunk, request });

            // Sequence: changeType(alt), append(altInit), append(chunk, request), changeType(home), append(homeInit)
            expect(mockParent.changeType.callCount).to.equal(2);
            expect(mockParent.appendToBuffer.callCount).to.equal(3);

            expect(mockParent.changeType.getCall(0).args[0]).to.equal(alternateRep);
            expect(mockParent.changeType.getCall(0).calledBefore(mockParent.appendToBuffer.getCall(0))).to.be.true; // jshint ignore:line

            expect(mockParent.appendToBuffer.getCall(0).args[0]).to.equal(alternateInit);
            expect(mockParent.appendToBuffer.getCall(1).args[0]).to.equal(chunk);
            expect(mockParent.appendToBuffer.getCall(1).args[1]).to.equal(request);

            expect(mockParent.changeType.getCall(1).args[0]).to.equal(homeRep);
            expect(mockParent.changeType.getCall(1).calledAfter(mockParent.appendToBuffer.getCall(1))).to.be.true; // jshint ignore:line
            expect(mockParent.changeType.getCall(1).calledBefore(mockParent.appendToBuffer.getCall(2))).to.be.true; // jshint ignore:line

            expect(mockParent.appendToBuffer.getCall(2).args[0]).to.equal(homeInit);
            expect(mockParent._onMediaFragmentLoaded.called).to.be.false; // jshint ignore:line
        });

        it('skips changeType calls when useChangeType is disabled in settings', async function () {
            const alternateRep = { id: 'video_500k' };
            const homeRep = { id: 'video_1000k' };
            const alternateInit = { representation: alternateRep };
            const homeInit = { representation: homeRep };
            mockParent.getInitChunkFromCache.withArgs('video_500k').returns(alternateInit);
            mockParent.getInitChunkFromCache.withArgs('video_1000k').returns(homeInit);

            const settings = Settings(context).getInstance();
            settings.update({ streaming: { buffer: { useChangeType: false } } });
            try {
                const mediaChunk = { representation: alternateRep, homeRepresentationId: 'video_1000k' };
                const request = {};
                await override._onMediaFragmentLoaded({ chunk: mediaChunk, request });
                expect(mockParent.changeType.called).to.be.false; // jshint ignore:line
                expect(mockParent.appendToBuffer.callCount).to.equal(3);
                expect(mockParent.appendToBuffer.getCall(0).args[0]).to.equal(alternateInit);
                expect(mockParent.appendToBuffer.getCall(1).args[0]).to.equal(mediaChunk);
                expect(mockParent.appendToBuffer.getCall(2).args[0]).to.equal(homeInit);
                expect(mockParent._onMediaFragmentLoaded.called).to.be.false; // jshint ignore:line
            } finally {
                settings.update({ streaming: { buffer: { useChangeType: true } } });
            }
        });

        it('skips changeType calls when capability is not supported', async function () {
            const alternateRep = { id: 'video_500k' };
            const homeRep = { id: 'video_1000k' };
            const alternateInit = { representation: alternateRep };
            const homeInit = { representation: homeRep };
            mockParent.getInitChunkFromCache.withArgs('video_500k').returns(alternateInit);
            mockParent.getInitChunkFromCache.withArgs('video_1000k').returns(homeInit);

            capabilities.supportsChangeType.returns(false);
            const mediaChunk = { representation: alternateRep, homeRepresentationId: 'video_1000k' };
            const request = {};
            await override._onMediaFragmentLoaded({ chunk: mediaChunk, request });
            expect(mockParent.changeType.called).to.be.false; // jshint ignore:line
            expect(mockParent.appendToBuffer.callCount).to.equal(3);
            expect(mockParent.appendToBuffer.getCall(0).args[0]).to.equal(alternateInit);
            expect(mockParent.appendToBuffer.getCall(1).args[0]).to.equal(mediaChunk);
            expect(mockParent.appendToBuffer.getCall(2).args[0]).to.equal(homeInit);
        });

        it('stalls when alternate init is not cached', async function () {
            const homeInit = { representation: { id: 'video_1000k' }, bytes: new Uint8Array(20) };
            mockParent.getInitChunkFromCache.withArgs('video_500k').returns(null);
            mockParent.getInitChunkFromCache.withArgs('video_1000k').returns(homeInit);

            await override._onMediaFragmentLoaded({
                chunk: { representation: { id: 'video_500k' }, homeRepresentationId: 'video_1000k' },
                request: {}
            });

            expect(mockParent.appendToBuffer.called).to.be.false; // jshint ignore:line
            expect(mockParent._onMediaFragmentLoaded.called).to.be.false; // jshint ignore:line
        });

        it('stalls when home init is not cached', async function () {
            const alternateInit = { representation: { id: 'video_500k' }, bytes: new Uint8Array(10) };
            mockParent.getInitChunkFromCache.withArgs('video_500k').returns(alternateInit);
            mockParent.getInitChunkFromCache.withArgs('video_1000k').returns(null);

            await override._onMediaFragmentLoaded({
                chunk: { representation: { id: 'video_500k' }, homeRepresentationId: 'video_1000k' },
                request: {}
            });

            expect(mockParent.appendToBuffer.called).to.be.false; // jshint ignore:line
            expect(mockParent._onMediaFragmentLoaded.called).to.be.false; // jshint ignore:line
        });

        it('stalls when both inits are not cached', async function () {
            await override._onMediaFragmentLoaded({
                chunk: { representation: { id: 'video_500k' }, homeRepresentationId: 'video_1000k' },
                request: {}
            });

            expect(mockParent.appendToBuffer.called).to.be.false; // jshint ignore:line
            expect(mockParent._onMediaFragmentLoaded.called).to.be.false; // jshint ignore:line
        });

        it('handles consecutive quality overrides correctly', async function () {
            const altRep = { id: 'video_500k' };
            const homeRep = { id: 'video_1000k' };
            const altInit = { representation: altRep, bytes: new Uint8Array(10) };
            const homeInit = { representation: homeRep, bytes: new Uint8Array(20) };
            mockParent.getInitChunkFromCache.withArgs('video_500k').returns(altInit);
            mockParent.getInitChunkFromCache.withArgs('video_1000k').returns(homeInit);

            await override._onMediaFragmentLoaded({
                chunk: { representation: altRep, homeRepresentationId: 'video_1000k' },
                request: {}
            });
            await override._onMediaFragmentLoaded({
                chunk: { representation: altRep, homeRepresentationId: 'video_1000k' },
                request: {}
            });

            expect(mockParent.changeType.callCount).to.equal(4);
            expect(mockParent.appendToBuffer.callCount).to.equal(6);
        });

        // Concurrent release. The event bus does not await handlers, so a flush
        // that releases more than one segment starts every handler back to back.

        function recordAppendOrder(order) {
            mockParent.appendToBuffer = function (chunk) {
                order.push('append:' + (chunk.label || chunk.name));
                // A real append settles on a later task, not immediately.
                return new Promise((resolve) => setTimeout(resolve, 0));
            };
            mockParent.changeType = function (representation) {
                order.push('changeType:' + representation.id);
                return Promise.resolve();
            };
            // Media no longer routes through the parent's handler. Recording it
            // anyway means a regression to it shows up as a wrong order string
            // rather than a missing append.
            mockParent._onMediaFragmentLoaded.callsFake(function (e) {
                order.push('parentAppend:' + e.chunk.name);
            });
        }

        function cacheInits() {
            const altRep = { id: 'video_500k' };
            const homeRep = { id: 'video_1000k' };
            mockParent.getInitChunkFromCache.withArgs('video_500k')
                .returns({ representation: altRep, bytes: new Uint8Array(10), label: 'altInit' });
            mockParent.getInitChunkFromCache.withArgs('video_1000k')
                .returns({ representation: homeRep, bytes: new Uint8Array(20), label: 'homeInit' });
            return { altRep, homeRep };
        }

        it('two overrides released together: each sandwich completes before the next begins', async function () {
            const { altRep } = cacheInits();
            const order = [];
            recordAppendOrder(order);

            const chunkA = { representation: altRep, homeRepresentationId: 'video_1000k', name: 'segA' };
            const chunkB = { representation: altRep, homeRepresentationId: 'video_1000k', name: 'segB' };

            const pA = override._onMediaFragmentLoaded({ chunk: chunkA, request: {} });
            const pB = override._onMediaFragmentLoaded({ chunk: chunkB, request: {} });
            await Promise.all([pA, pB]);

            expect(order.join(' > ')).to.equal([
                'changeType:video_500k', 'append:altInit', 'append:segA',
                'changeType:video_1000k', 'append:homeInit',
                'changeType:video_500k', 'append:altInit', 'append:segB',
                'changeType:video_1000k', 'append:homeInit'
            ].join(' > '));
        });

        it('override plus ordinary segment: the ordinary segment does not land inside the sandwich', async function () {
            const { altRep, homeRep } = cacheInits();
            const order = [];
            recordAppendOrder(order);

            const overrideChunk = { representation: altRep, homeRepresentationId: 'video_1000k', name: 'segA' };
            const plainChunk = { representation: homeRep, homeRepresentationId: null, name: 'segB' };

            const pA = override._onMediaFragmentLoaded({ chunk: overrideChunk, request: {} });
            const pB = override._onMediaFragmentLoaded({ chunk: plainChunk, request: {} });
            await Promise.all([pA, pB]);

            // segA was released first, so its whole sandwich precedes segB.
            expect(order.join(' > ')).to.equal([
                'changeType:video_500k', 'append:altInit', 'append:segA',
                'changeType:video_1000k', 'append:homeInit',
                'append:segB'
            ].join(' > '));
        });

        it('a failed sandwich does not stop the next release from being appended', async function () {
            const { altRep, homeRep } = cacheInits();
            const order = [];
            recordAppendOrder(order);
            const failing = mockParent.appendToBuffer;
            mockParent.appendToBuffer = function (chunk) {
                if (chunk.name === 'segA') {
                    return Promise.reject(new Error('append failed'));
                }
                return failing(chunk);
            };

            const chunkA = { representation: altRep, homeRepresentationId: 'video_1000k', name: 'segA' };
            const plainChunk = { representation: homeRep, homeRepresentationId: null, name: 'segB' };

            const pA = override._onMediaFragmentLoaded({ chunk: chunkA, request: {} });
            const pB = override._onMediaFragmentLoaded({ chunk: plainChunk, request: {} });
            await Promise.all([pA, pB]);

            expect(order).to.include('append:segB');
        });

        it('two ordinary segments released together: the second is not appended until the first settles', async function () {
            const homeRep = { id: 'video_1000k' };
            const order = [];
            let settleFirst;
            mockParent.appendToBuffer = function (chunk) {
                order.push('append:' + chunk.name);
                if (chunk.name === 'segA') {
                    return new Promise((resolve) => { settleFirst = resolve; });
                }
                return Promise.resolve();
            };

            const pA = override._onMediaFragmentLoaded({
                chunk: { representation: homeRep, homeRepresentationId: null, name: 'segA' },
                request: {}
            });
            const pB = override._onMediaFragmentLoaded({
                chunk: { representation: homeRep, homeRepresentationId: null, name: 'segB' },
                request: {}
            });

            // Drain the microtask queue: everything the chain can do without segA
            // settling has now happened.
            await new Promise((resolve) => setTimeout(resolve, 0));

            // segB must still be waiting. Two segments enqueued into the same
            // SourceBufferSink append window share a trace index, so both would be
            // credited with segA's buffer delta and the mock buffer would drift (R5.1).
            expect(order).to.eql(['append:segA']);

            settleFirst();
            await Promise.all([pA, pB]);
            expect(order).to.eql(['append:segA', 'append:segB']);
        });
    });

    // _onInitFragmentLoaded + Dodge-owned alternate init cache

    describe('_onInitFragmentLoaded', function () {

        it('delegates to parent for home init (no homeRepresentationId)', async function () {
            const e = { chunk: { representation: { id: 'video_1000k' }, homeRepresentationId: null } };
            await override._onInitFragmentLoaded(e);
            expect(mockParent._onInitFragmentLoaded.calledOnce).to.be.true; // jshint ignore:line
            expect(mockParent._onInitFragmentLoaded.firstCall.args[0]).to.equal(e);
        });

        it('alternate init is cached locally and does not delegate to parent', function () {
            const chunk = { representation: { id: 'video_500k' }, homeRepresentationId: 'video_1000k' };
            override._onInitFragmentLoaded({ chunk });
            expect(mockParent._onInitFragmentLoaded.called).to.be.false; // jshint ignore:line
        });

        it('home init is both cached locally and delegated to parent', async function () {
            const homeChunk = { representation: { id: 'video_1000k' }, homeRepresentationId: null };
            await override._onInitFragmentLoaded({ chunk: homeChunk });
            expect(mockParent._onInitFragmentLoaded.calledOnce).to.be.true; // jshint ignore:line
        });

        it('sandwich retrieves alternate init from the local cache (parent cache never consulted for alt)', async function () {
            const alternateInit = { representation: { id: 'video_500k' }, homeRepresentationId: 'video_1000k', bytes: new Uint8Array(10) };
            const homeInit = { representation: { id: 'video_1000k' }, bytes: new Uint8Array(20) };
            // Only home is in the parent cache. Local cache is primed by _onInitFragmentLoaded.
            mockParent.getInitChunkFromCache.withArgs('video_500k').returns(null);
            mockParent.getInitChunkFromCache.withArgs('video_1000k').returns(homeInit);

            override._onInitFragmentLoaded({ chunk: alternateInit });

            const mediaChunk = { representation: { id: 'video_500k' }, homeRepresentationId: 'video_1000k' };
            await override._onMediaFragmentLoaded({ chunk: mediaChunk, request: {} });

            expect(mockParent.appendToBuffer.callCount).to.equal(3);
            expect(mockParent.appendToBuffer.getCall(0).args[0]).to.equal(alternateInit);
            expect(mockParent.appendToBuffer.getCall(1).args[0]).to.equal(mediaChunk);
            expect(mockParent.appendToBuffer.getCall(2).args[0]).to.equal(homeInit);
        });

        it('local cache does not depend on streaming.cacheInitSegments - sandwich succeeds regardless', async function () {
            // No Settings object is involved here; the local cache is unconditional.
            const alternateInit = { representation: { id: 'video_500k' }, homeRepresentationId: 'video_1000k', bytes: new Uint8Array(5) };
            const homeInit = { representation: { id: 'video_1000k' }, bytes: new Uint8Array(8) };
            mockParent.getInitChunkFromCache.withArgs('video_1000k').returns(homeInit);

            override._onInitFragmentLoaded({ chunk: alternateInit });

            await override._onMediaFragmentLoaded({
                chunk: { representation: { id: 'video_500k' }, homeRepresentationId: 'video_1000k' },
                request: {}
            });

            expect(mockParent.appendToBuffer.callCount).to.equal(3);
        });

        it('a quality override segment queued before a home representation switch is still appended', async function () {
            const alternateInit = { representation: { id: 'video_500k' }, homeRepresentationId: 'video_1000k' };
            const homeInit = { representation: { id: 'video_1000k' } };
            mockParent.getInitChunkFromCache.withArgs('video_500k').returns(null);
            mockParent.getInitChunkFromCache.withArgs('video_1000k').returns(homeInit);

            override._onInitFragmentLoaded({ chunk: alternateInit });

            EventBus(context).getInstance().trigger(MediaPlayerEvents.QUALITY_CHANGE_REQUESTED, { mediaType: 'video' });

            const mediaChunk = { representation: { id: 'video_500k' }, homeRepresentationId: 'video_1000k' };
            await override._onMediaFragmentLoaded({ chunk: mediaChunk, request: {} });

            expect(mockParent.appendToBuffer.callCount).to.equal(3);
            expect(mockParent.appendToBuffer.getCall(1).args[0]).to.equal(mediaChunk);
        });

        it('a cached alternate init stays usable across repeated home representation switches', async function () {
            const alternateInit = { representation: { id: 'video_500k' }, homeRepresentationId: 'video_1000k' };
            const homeInit = { representation: { id: 'video_1000k' } };
            mockParent.getInitChunkFromCache.withArgs('video_500k').returns(null);
            mockParent.getInitChunkFromCache.withArgs('video_1000k').returns(homeInit);

            override._onInitFragmentLoaded({ chunk: alternateInit });

            const bus = EventBus(context).getInstance();
            bus.trigger(MediaPlayerEvents.QUALITY_CHANGE_REQUESTED, { mediaType: 'video' });
            bus.trigger(MediaPlayerEvents.QUALITY_CHANGE_REQUESTED, { mediaType: 'video' });

            await override._onMediaFragmentLoaded({
                chunk: { representation: { id: 'video_500k' }, homeRepresentationId: 'video_1000k' },
                request: {}
            });

            expect(mockParent.appendToBuffer.callCount).to.equal(3);
        });

        it('reset clears the local cache', async function () {
            const alternateInit = { representation: { id: 'video_500k' }, homeRepresentationId: 'video_1000k' };
            const homeInit = { representation: { id: 'video_1000k' } };
            mockParent.getInitChunkFromCache.withArgs('video_1000k').returns(homeInit);

            override._onInitFragmentLoaded({ chunk: alternateInit });
            override.reset();

            await override._onMediaFragmentLoaded({
                chunk: { representation: { id: 'video_500k' }, homeRepresentationId: 'video_1000k' },
                request: {}
            });

            expect(mockParent.appendToBuffer.called).to.be.false; // jshint ignore:line
        });
    });

    // Init appends are serialized with media appends

    describe('init append serialization', function () {

        // SourceBufferSink drains its appendQueue in enqueue order, so whichever
        // path enqueues first reaches the SourceBuffer first. Media appends are
        // chained; if init appends are not, an init released while the chain is
        // still draining jumps ahead of media that belongs before it, and that
        // media is then parsed under the wrong initialization segment.
        function recordOrder(order) {
            mockParent.appendToBuffer = function (chunk) {
                order.push('append:' + (chunk.label || chunk.name));
                return new Promise((resolve) => setTimeout(resolve, 0));
            };
            mockParent.changeType = function (representation) {
                order.push('changeType:' + representation.id);
                return Promise.resolve();
            };
            // Tripwire: see recordAppendOrder above.
            mockParent._onMediaFragmentLoaded.callsFake(function (e) {
                order.push('parentMedia:' + e.chunk.name);
            });
            mockParent._onInitFragmentLoaded.callsFake(function (e) {
                order.push('parentInit:' + e.chunk.label);
            });
        }

        const homeRep = { id: 'video_1000k' };
        const altRep = { id: 'video_500k' };

        it('an init released while a media append is in flight lands after it', async function () {
            const order = [];
            recordOrder(order);

            const media = { representation: homeRep, homeRepresentationId: null, name: 'segA' };
            const init = { representation: homeRep, homeRepresentationId: null, label: 'init2' };

            const pMedia = override._onMediaFragmentLoaded({ chunk: media, request: {} });
            const pInit = override._onInitFragmentLoaded({ chunk: init });
            await Promise.all([pMedia, pInit]);

            expect(order.join(' > ')).to.equal('append:segA > parentInit:init2');
        });

        it('an init released mid-sandwich does not land inside it', async function () {
            const order = [];
            recordOrder(order);
            mockParent.getInitChunkFromCache.withArgs('video_500k')
                .returns({ representation: altRep, label: 'altInit' });
            mockParent.getInitChunkFromCache.withArgs('video_1000k')
                .returns({ representation: homeRep, label: 'homeInit' });

            const overrideChunk = { representation: altRep, homeRepresentationId: 'video_1000k', name: 'segA' };
            // A third representation, so the release cannot change which home init
            // the sandwich resolves and the assertion is purely about ordering.
            const init = { representation: { id: 'video_2000k' }, homeRepresentationId: null, label: 'init2' };

            const pMedia = override._onMediaFragmentLoaded({ chunk: overrideChunk, request: {} });
            const pInit = override._onInitFragmentLoaded({ chunk: init });
            await Promise.all([pMedia, pInit]);

            expect(order.join(' > ')).to.equal([
                'changeType:video_500k', 'append:altInit', 'append:segA',
                'changeType:video_1000k', 'append:homeInit',
                'parentInit:init2'
            ].join(' > '));
        });

        it('an init released on an idle chain still appends', async function () {
            const order = [];
            recordOrder(order);

            await override._onInitFragmentLoaded({
                chunk: { representation: homeRep, homeRepresentationId: null, label: 'init1' }
            });

            expect(order.join(' > ')).to.equal('parentInit:init1');
        });

        it('an alternate init is cached without appending, and does not stall the chain', async function () {
            const order = [];
            recordOrder(order);

            override._onInitFragmentLoaded({
                chunk: { representation: altRep, homeRepresentationId: 'video_1000k', label: 'altInit' }
            });
            await override._onMediaFragmentLoaded({
                chunk: { representation: homeRep, homeRepresentationId: null, name: 'segA' },
                request: {}
            });

            expect(order.join(' > ')).to.equal('append:segA');
        });
    });
});
