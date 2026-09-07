import ScheduleController from '../../../../src/streaming/controllers/ScheduleController.js';
import Settings from '../../../../src/core/Settings.js';
import EventBus from '../../../../src/core/EventBus.js';
import Events from '../../../../src/core/events/Events.js';
import DashMetricsMock from '../../mocks/DashMetricsMock.js';
import MediaPlayerModelMock from '../../mocks/MediaPlayerModelMock.js';
import TextControllerMock from '../../mocks/TextControllerMock.js';
import PlaybackControllerMock from '../../mocks/PlaybackControllerMock.js';

import sinon from 'sinon';
import { expect } from 'chai';

// ************************************************************************
// TESTS
// ************************************************************************

/**
 * Which of the two fragment-needed events ScheduleController fires is the
 * decision the Dodge guard in _getNextFragment changes. Drive it through
 * startScheduleTimer, the public entry point, and record the event.
 */
describe('Dodge init path selection', function () {

    const context = {};
    const eventBus = EventBus(context).getInstance();
    const settings = Settings(context).getInstance();

    let scheduleController,
        fired,
        clock;

    const REPRESENTATION = { id: 'rep_video_1000k', segmentDuration: 4 };

    function record(e, name) {
        fired.push(name);
    }

    const onInit = (e) => record(e, 'init');
    const onMedia = (e) => record(e, 'media');
    // EventBus matches a listener on handler and scope together, so the same
    // object has to be handed to both on() and off().
    const listenerScope = {};

    /**
     * @param {number} remainingInitCycles - What the DashHandler reports. -1 is
     *        the vanilla stub (no defense), 0 a defended representation whose
     *        init cycles are used up, > 0 one with cycles still to send.
     * @param {number} [restartTo] - What restartInitCycles() reports once the
     *        sequence has been rewound.
     */
    function makeController(remainingInitCycles, restartTo = remainingInitCycles) {
        const restartInitCycles = sinon.stub().returns(restartTo);
        const dashHandler = {
            getRemainingInitCycles: sinon.stub().returns(remainingInitCycles),
            restartInitCycles
        };

        const mediaPlayerModel = new MediaPlayerModelMock();
        mediaPlayerModel.getScheduleTimeout = () => 0;

        // An empty buffer, so the scheduler always has a reason to fetch and the
        // choice of event is the only thing under test.
        const dashMetrics = new DashMetricsMock();
        dashMetrics.getCurrentBufferLevel = () => 0;

        const controller = ScheduleController(context).create({
            streamInfo: { id: 'stream_0' },
            type: 'video',
            dashHandler,
            dashMetrics,
            mediaPlayerModel,
            textController: new TextControllerMock(),
            playbackController: new PlaybackControllerMock(),
            representationController: { getCurrentRepresentation: () => REPRESENTATION },
            abrController: {
                handlePendingManualQualitySwitch: () => false,
                checkPlaybackQuality: () => false
            },
            bufferController: { getIsBufferingCompleted: () => false },
            fragmentModel: { getRequests: () => [] },
            settings
        });
        controller.initialize(true);
        return { controller, restartInitCycles };
    }

    // Run one scheduling pass and report which event it produced.
    function schedule(controller) {
        fired = [];
        controller.startScheduleTimer(0);
        clock.tick(1);
        return fired;
    }

    beforeEach(function () {
        fired = [];
        clock = sinon.useFakeTimers();
        eventBus.on(Events.INIT_FRAGMENT_NEEDED, onInit, listenerScope);
        eventBus.on(Events.MEDIA_FRAGMENT_NEEDED, onMedia, listenerScope);
    });

    afterEach(function () {
        eventBus.off(Events.INIT_FRAGMENT_NEEDED, onInit, listenerScope);
        eventBus.off(Events.MEDIA_FRAGMENT_NEEDED, onMedia, listenerScope);
        if (scheduleController) {
            scheduleController.reset();
            scheduleController = null;
        }
        clock.restore();
        settings.reset();
    });

    describe('a defended representation that has used up its init cycles', function () {

        // StreamProcessor sets this after a seek aborted the SourceBuffer, so
        // that the init segment is appended again. Dodge owns how init segments
        // reach the buffer, so it has to replay its init cycles; skipping the
        // request leaves the SourceBuffer without an init segment and latches
        // initSegmentRequired, which is only cleared on the init path.
        it('replays its init cycles when the player asks for the init segment again', function () {
            const made = makeController(0, 2);
            scheduleController = made.controller;
            scheduleController.setLastInitializedRepresentationId(REPRESENTATION.id);
            scheduleController.setInitSegmentRequired(true);

            expect(schedule(scheduleController)).to.eql(['init']);
        });

        it('rewinds the cycle sequence exactly once for one such request', function () {
            const made = makeController(0, 2);
            scheduleController = made.controller;
            scheduleController.setLastInitializedRepresentationId(REPRESENTATION.id);
            scheduleController.setInitSegmentRequired(true);

            schedule(scheduleController);

            expect(made.restartInitCycles.callCount).to.equal(1);
        });

        it('takes the media path while no init segment has been asked for', function () {
            const made = makeController(0);
            scheduleController = made.controller;
            // _initFragmentNeeded records the representation as the last init cycle
            // goes out, so steady state is a used-up count and a recorded id.
            scheduleController.setLastInitializedRepresentationId(REPRESENTATION.id);

            expect(schedule(scheduleController)).to.eql(['media']);
            expect(made.restartInitCycles.called).to.be.false; // jshint ignore:line
        });

        // A self-initialized stream is covered by the extended manifest but
        // carries no init cycles, so there is nothing to replay.
        it('stays on the media path when rewinding yields no cycles', function () {
            const made = makeController(0, 0);
            scheduleController = made.controller;
            scheduleController.setLastInitializedRepresentationId(REPRESENTATION.id);
            scheduleController.setInitSegmentRequired(true);

            expect(schedule(scheduleController)).to.eql(['media']);
        });
    });

    describe('a defended representation with init cycles still to send', function () {

        it('takes the init path without being asked for an init segment', function () {
            const made = makeController(2);
            scheduleController = made.controller;

            expect(schedule(scheduleController)).to.eql(['init']);
        });

        it('does not rewind a sequence that has not finished', function () {
            const made = makeController(2);
            scheduleController = made.controller;
            scheduleController.setInitSegmentRequired(true);

            schedule(scheduleController);

            expect(made.restartInitCycles.called).to.be.false; // jshint ignore:line
        });
    });

    describe('vanilla playback, where the DashHandler stub reports -1', function () {

        it('takes the init path when an init segment is required', function () {
            const made = makeController(-1);
            scheduleController = made.controller;
            scheduleController.setInitSegmentRequired(true);

            expect(schedule(scheduleController)).to.eql(['init']);
        });

        it('takes the init path when the representation is not the initialized one', function () {
            const made = makeController(-1);
            scheduleController = made.controller;

            expect(schedule(scheduleController)).to.eql(['init']);
        });

        it('takes the media path once the representation has been initialized', function () {
            const made = makeController(-1);
            scheduleController = made.controller;
            scheduleController.setLastInitializedRepresentationId(REPRESENTATION.id);

            expect(schedule(scheduleController)).to.eql(['media']);
        });

        it('never rewinds, since there are no cycles to rewind', function () {
            const made = makeController(-1);
            scheduleController = made.controller;
            scheduleController.setInitSegmentRequired(true);

            schedule(scheduleController);

            expect(made.restartInitCycles.called).to.be.false; // jshint ignore:line
        });
    });
});
