import DodgeScheduleControllerOverride from '../../../../src/dodge/overrides/DodgeScheduleControllerOverride.js';
import Debug from '../../../../src/core/Debug.js';
import { createDodgeContext, releaseDodgeContexts } from '../../helpers/DodgeContexts.js';

import sinon from 'sinon';
import { expect } from 'chai';

// ************************************************************************
// TESTS
// ************************************************************************

describe('DodgeScheduleControllerOverride', function () {

    afterEach(function () {
        releaseDodgeContexts();
    });

    function makeOverride({ parentResult, isTrailing, hasDashHandler = true, isDefended = false, scheduleWaitBase = 100, scheduleWaitRandom = 50, isStalled = null }) {
        const parentShouldClearStub = sinon.stub().returns(parentResult);
        const parentStartScheduleTimerStub = sinon.stub();
        const getIsTrailingStub = sinon.stub().returns(isTrailing);
        const getIsDefendedStub = sinon.stub().returns(isDefended);

        const parent = {
            _shouldClearScheduleTimer: parentShouldClearStub,
            startScheduleTimer: parentStartScheduleTimerStub,
        };
        const dashHandler = hasDashHandler ? { getIsTrailing: getIsTrailingStub, getIsDefended: getIsDefendedStub } : undefined;
        const settings = {
            get: () => ({ dodge: { scheduleWaitBase, scheduleWaitRandom } })
        };

        // Fresh context per call so the Debug singleton (and therefore the
        // logger the factory creates) is isolated. Stub getLogger on that
        // singleton to return a spy we can assert against.
        const context = createDodgeContext();
        const loggerSpy = { fatal: sinon.spy(), error: sinon.spy(), warn: sinon.spy(), info: sinon.spy(), debug: sinon.spy() };
        sinon.stub(Debug(context).getInstance(), 'getLogger').returns(loggerSpy);

        // The override reads the stall through the DodgeHandler the player
        // registered on the context, the same way the GapController override
        // reaches it. A null one stands for the module not being registered.
        const isStalledStub = sinon.stub().returns(!!isStalled);
        if (isStalled !== null) {
            context._dodgeHandler = { isStalled: isStalledStub };
        }

        const updateBufferLevelStub = sinon.stub();
        const bufferController = { updateBufferLevel: updateBufferLevelStub };

        const override = DodgeScheduleControllerOverride.call(
            { context, parent, factory: {} },
            { dashHandler, settings, bufferController, streamInfo: { id: 'stream-1' }, type: 'text' }
        );

        return { override, parentShouldClearStub, parentStartScheduleTimerStub, getIsTrailingStub, getIsDefendedStub, isStalledStub, updateBufferLevelStub, loggerSpy };
    }

    describe('_shouldClearScheduleTimer', function () {

        it('parent returns false (keep timer), not trailing: returns false', function () {
            const { override } = makeOverride({ parentResult: false, isTrailing: false });
            expect(override._shouldClearScheduleTimer()).to.be.false; // jshint ignore:line
        });

        it('parent returns false (keep timer), during trailing: still returns false', function () {
            const { override } = makeOverride({ parentResult: false, isTrailing: true });
            expect(override._shouldClearScheduleTimer()).to.be.false; // jshint ignore:line
        });

        it('parent returns true (clear timer), not trailing: returns true (clears normally)', function () {
            const { override } = makeOverride({ parentResult: true, isTrailing: false });
            expect(override._shouldClearScheduleTimer()).to.be.true; // jshint ignore:line
        });

        it('parent returns true (clear timer), during trailing: returns false (keeps timer for padding downloads)', function () {
            // During trailing, the schedule timer must continue running so that padding
            // cycles are requested even though normal playback appears to have ended.
            const { override } = makeOverride({ parentResult: true, isTrailing: true });
            expect(override._shouldClearScheduleTimer()).to.be.false; // jshint ignore:line
        });

        it('dashHandler absent: falls back to parent result without crashing', function () {
            const { override } = makeOverride({ parentResult: true, isTrailing: false, hasDashHandler: false });
            expect(override._shouldClearScheduleTimer()).to.be.true; // jshint ignore:line
        });

        // A stream that gave up on a download must not be scheduled again. The
        // stall reaches here rather than being enforced where it is detected,
        // because StreamProcessor restarts the timer for text on every fragment
        // completion, before it reads anything DodgeHandler can null.
        it('a stalled stream clears the timer even when the parent would keep it', function () {
            const { override, isStalledStub } = makeOverride({ parentResult: false, isTrailing: false, isStalled: true });
            expect(override._shouldClearScheduleTimer()).to.be.true; // jshint ignore:line
            expect(isStalledStub.calledWith('stream-1', 'text')).to.be.true; // jshint ignore:line
        });

        it('a stalled stream clears the timer even during trailing', function () {
            const { override } = makeOverride({ parentResult: true, isTrailing: true, isStalled: true });
            expect(override._shouldClearScheduleTimer()).to.be.true; // jshint ignore:line
        });

        it('an unstalled stream is unaffected, trailing still keeps the timer', function () {
            const { override } = makeOverride({ parentResult: true, isTrailing: true, isStalled: false });
            expect(override._shouldClearScheduleTimer()).to.be.false; // jshint ignore:line
        });

        it('no DodgeHandler on the context: falls back to parent result without crashing', function () {
            const { override } = makeOverride({ parentResult: true, isTrailing: false });
            expect(override._shouldClearScheduleTimer()).to.be.true; // jshint ignore:line
        });
    });

    describe('startScheduleTimer', function () {

        it('not defended: passes value through to parent unchanged', function () {
            const { override, parentStartScheduleTimerStub } = makeOverride({ parentResult: false, isTrailing: false, isDefended: false });
            override.startScheduleTimer(0);
            expect(parentStartScheduleTimerStub.calledOnce).to.be.true; // jshint ignore:line
            expect(parentStartScheduleTimerStub.firstCall.args[0]).to.equal(0);
        });

        it('defended with value = 0: enforces minimum random delay', function () {
            const { override, parentStartScheduleTimerStub } = makeOverride({
                parentResult: false, isTrailing: false, isDefended: true,
                scheduleWaitBase: 100, scheduleWaitRandom: 50
            });
            override.startScheduleTimer(0);
            expect(parentStartScheduleTimerStub.calledOnce).to.be.true; // jshint ignore:line
            const delay = parentStartScheduleTimerStub.firstCall.args[0];
            expect(delay).to.be.at.least(100);
            expect(delay).to.be.at.most(150);
        });

        it('defended with value larger than max delay: keeps the larger value', function () {
            const { override, parentStartScheduleTimerStub } = makeOverride({
                parentResult: false, isTrailing: false, isDefended: true,
                scheduleWaitBase: 100, scheduleWaitRandom: 50
            });
            override.startScheduleTimer(500);
            expect(parentStartScheduleTimerStub.calledOnce).to.be.true; // jshint ignore:line
            expect(parentStartScheduleTimerStub.firstCall.args[0]).to.equal(500);
        });

        it('defended with value between base and max: keeps the original value', function () {
            const { override, parentStartScheduleTimerStub } = makeOverride({
                parentResult: false, isTrailing: false, isDefended: true,
                scheduleWaitBase: 100, scheduleWaitRandom: 50
            });
            override.startScheduleTimer(120);
            expect(parentStartScheduleTimerStub.calledOnce).to.be.true; // jshint ignore:line
            const delay = parentStartScheduleTimerStub.firstCall.args[0];
            expect(delay).to.be.at.least(120);
        });

        it('defended with scheduleWaitRandom = 0: delay is exactly scheduleWaitBase', function () {
            const { override, parentStartScheduleTimerStub } = makeOverride({
                parentResult: false, isTrailing: false, isDefended: true,
                scheduleWaitBase: 100, scheduleWaitRandom: 0
            });
            override.startScheduleTimer(0);
            expect(parentStartScheduleTimerStub.firstCall.args[0]).to.equal(100);
        });

        it('defended with scheduleWaitRandom < 0: clamps to scheduleWaitBase and warns exactly once', function () {
            const { override, parentStartScheduleTimerStub, loggerSpy } = makeOverride({
                parentResult: false, isTrailing: false, isDefended: true,
                scheduleWaitBase: 100, scheduleWaitRandom: -50
            });
            for (let i = 0; i < 20; i++) {
                override.startScheduleTimer(0);
            }
            // Every call must land exactly at the base (no downward jitter).
            for (const call of parentStartScheduleTimerStub.getCalls()) {
                expect(call.args[0]).to.equal(100);
            }
            // Warn once: flag is scoped to this factory instance, so exactly one
            // warning regardless of how many times _getScheduleWait is invoked.
            const negativeWarnings = loggerSpy.warn.getCalls().filter(
                c => c.args[0] && c.args[0].indexOf('scheduleWaitRandom is not a non-negative number') !== -1
            );
            expect(negativeWarnings.length).to.equal(1);
        });

        it('defended with scheduleWaitBase < 0: clamps to 0 and warns exactly once', function () {
            const { override, parentStartScheduleTimerStub, loggerSpy } = makeOverride({
                parentResult: false, isTrailing: false, isDefended: true,
                scheduleWaitBase: -100, scheduleWaitRandom: 0
            });
            for (let i = 0; i < 20; i++) {
                override.startScheduleTimer(0);
            }
            // With base clamped to 0 and random = 0, every delay is exactly 0.
            for (const call of parentStartScheduleTimerStub.getCalls()) {
                expect(call.args[0]).to.equal(0);
            }
            const negativeWarnings = loggerSpy.warn.getCalls().filter(
                c => c.args[0] && c.args[0].indexOf('scheduleWaitBase is not a non-negative number') !== -1
            );
            expect(negativeWarnings.length).to.equal(1);
        });

        it('defended with a non-numeric scheduleWaitBase: treats as 0 and warns exactly once', function () {
            const { override, parentStartScheduleTimerStub, loggerSpy } = makeOverride({
                parentResult: false, isTrailing: false, isDefended: true,
                scheduleWaitBase: 'abc', scheduleWaitRandom: 0
            });
            for (let i = 0; i < 20; i++) {
                override.startScheduleTimer(0);
            }
            // Without validation the delay is NaN, and setTimeout runs NaN
            // immediately, so the random walk collapses.
            for (const call of parentStartScheduleTimerStub.getCalls()) {
                expect(call.args[0]).to.equal(0);
            }
            const warnings = loggerSpy.warn.getCalls().filter(
                c => c.args[0] && c.args[0].indexOf('scheduleWaitBase is not a non-negative number') !== -1
            );
            expect(warnings.length).to.equal(1);
        });

        it('defended with a non-numeric scheduleWaitRandom: clamps to scheduleWaitBase', function () {
            const { override, parentStartScheduleTimerStub } = makeOverride({
                parentResult: false, isTrailing: false, isDefended: true,
                scheduleWaitBase: 100, scheduleWaitRandom: 'abc'
            });
            for (let i = 0; i < 20; i++) {
                override.startScheduleTimer(0);
            }
            for (const call of parentStartScheduleTimerStub.getCalls()) {
                expect(call.args[0]).to.equal(100);
            }
        });

        it('defended with undefined value: treats as 0 and enforces minimum delay', function () {
            const { override, parentStartScheduleTimerStub } = makeOverride({
                parentResult: false, isTrailing: false, isDefended: true,
                scheduleWaitBase: 100, scheduleWaitRandom: 0
            });
            override.startScheduleTimer(undefined);
            expect(parentStartScheduleTimerStub.firstCall.args[0]).to.equal(100);
        });

        it('dashHandler absent: passes value through to parent unchanged', function () {
            const { override, parentStartScheduleTimerStub } = makeOverride({
                parentResult: false, isTrailing: false, hasDashHandler: false
            });
            override.startScheduleTimer(0);
            expect(parentStartScheduleTimerStub.firstCall.args[0]).to.equal(0);
        });
    });

    describe('refreshing the buffer level during the trailing phase', function () {

        // The mock buffer only reaches the scheduler through
        // BUFFER_LEVEL_UPDATED, which BufferController fires from
        // _updateBufferLevel().
        it('refreshes the buffer level during the trailing phase', function () {
            const { override, updateBufferLevelStub } = makeOverride({ parentResult: true, isTrailing: true, isDefended: true });
            expect(override._shouldClearScheduleTimer()).to.be.false; // jshint ignore:line
            expect(updateBufferLevelStub.calledOnce).to.be.true; // jshint ignore:line
        });

        it('refreshes on every tick of the phase, not only the first', function () {
            const { override, updateBufferLevelStub } = makeOverride({ parentResult: true, isTrailing: true, isDefended: true });
            override._shouldClearScheduleTimer();
            override._shouldClearScheduleTimer();
            override._shouldClearScheduleTimer();
            expect(updateBufferLevelStub.callCount).to.equal(3);
        });

        it('leaves the buffer level alone during ordinary defended playback', function () {
            const { override, updateBufferLevelStub } = makeOverride({ parentResult: false, isTrailing: false, isDefended: true });
            override._shouldClearScheduleTimer();
            expect(updateBufferLevelStub.called).to.be.false; // jshint ignore:line
        });

        it('leaves the buffer level alone when no defense is active', function () {
            const { override, updateBufferLevelStub } = makeOverride({ parentResult: false, isTrailing: false, isDefended: false });
            override._shouldClearScheduleTimer();
            expect(updateBufferLevelStub.called).to.be.false; // jshint ignore:line
        });

        it('does not refresh a stalled stream, which is finished', function () {
            const { override, updateBufferLevelStub } = makeOverride({ parentResult: true, isTrailing: true, isDefended: true, isStalled: true });
            expect(override._shouldClearScheduleTimer()).to.be.true; // jshint ignore:line
            expect(updateBufferLevelStub.called).to.be.false; // jshint ignore:line
        });
    });

});
