import BufferController from '../../../../src/streaming/controllers/BufferController.js';
import Settings from '../../../../src/core/Settings.js';
import EventBus from '../../../../src/core/EventBus.js';
import Events from '../../../../src/core/events/Events.js';

import StreamControllerMock from '../../mocks/StreamControllerMock.js';
import PlaybackControllerMock from '../../mocks/PlaybackControllerMock.js';
import DashMetricsMock from '../../mocks/DashMetricsMock.js';
import AdapterMock from '../../mocks/AdapterMock.js';
import MediaPlayerModelMock from '../../mocks/MediaPlayerModelMock.js';
import ErrorHandlerMock from '../../mocks/ErrorHandlerMock.js';
import MediaControllerMock from '../../mocks/MediaControllerMock.js';
import AbrControllerMock from '../../mocks/AbrControllerMock.js';
import TextControllerMock from '../../mocks/TextControllerMock.js';
import RepresentationControllerMock from '../../mocks/RepresentationControllerMock.js';

import { expect } from 'chai';

// ************************************************************************
// TESTS
// ************************************************************************

/**
 * The mock buffer is a signed correction: onBufferCycleLoaded adds
 * `segmentDuration - actualDuration` per buffered cycle, which is negative
 * whenever a segment runs longer than the MPD says (R5.6 pins that). The
 * correction stays signed so it accumulates across cycles, but the level the
 * player reports is a duration: dash.js already clamps the real part, and every
 * consumer of getBufferLevel() treats it as non-negative.
 */
describe('Dodge mock buffer reporting', function () {

    const context = {};
    const settings = Settings(context).getInstance();
    const eventBus = EventBus(context).getInstance();

    let bufferController;

    beforeEach(function () {
        bufferController = BufferController(context).create({
            streamInfo: { id: 'stream-1' },
            type: 'video',
            dashMetrics: new DashMetricsMock(),
            errHandler: new ErrorHandlerMock(),
            streamController: new StreamControllerMock(),
            mediaController: new MediaControllerMock(),
            adapter: new AdapterMock(),
            textController: new TextControllerMock(),
            abrController: new AbrControllerMock(),
            representationController: new RepresentationControllerMock(),
            playbackController: new PlaybackControllerMock(),
            mediaPlayerModel: new MediaPlayerModelMock(),
            settings
        });
    });

    afterEach(function () {
        bufferController.reset();
        bufferController = null;
        settings.reset();
    });
    
    it('never reports a negative level for a negative correction', function () {
        bufferController.setMockBuffer(-0.5);
        bufferController.updateBufferLevel();

        expect(bufferController.getBufferLevel()).to.be.at.least(0);
    });

    it('never reports a negative level for a large negative correction', function () {
        bufferController.setMockBuffer(-30);
        bufferController.updateBufferLevel();

        expect(bufferController.getBufferLevel()).to.be.at.least(0);
    });

    it('still adds a positive correction to the reported level', function () {
        bufferController.setMockBuffer(2.5);
        bufferController.updateBufferLevel();

        expect(bufferController.getBufferLevel()).to.equal(2.5);
    });

    it('reports zero when no correction is set', function () {
        bufferController.updateBufferLevel();

        expect(bufferController.getBufferLevel()).to.equal(0);
    });

    it('announces the same non-negative level on BUFFER_LEVEL_UPDATED', function () {
        const seen = [];
        const listener = {};
        const record = (e) => seen.push(e.bufferLevel);
        eventBus.on(Events.BUFFER_LEVEL_UPDATED, record, listener);

        try {
            bufferController.setMockBuffer(-0.5);
            bufferController.updateBufferLevel();
        } finally {
            eventBus.off(Events.BUFFER_LEVEL_UPDATED, record, listener);
        }

        expect(seen).to.have.lengthOf(1);
        expect(seen[0]).to.be.at.least(0);
    });
});
