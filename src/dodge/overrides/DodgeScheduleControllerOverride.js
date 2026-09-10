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

/**
 * Dodge override for ScheduleController:
 *
 * 1. Keeps the schedule timer running during the trailing phase (padding
 *    cycles after all playable content).
 * 2. Enforces a random-walk delay on every schedule timer start when a
 *    Dodge defense is active, so that buffered segment loads (which go
 *    through the normal dash.js _onBytesAppended → startScheduleTimer(0)
 *    path) still get the same random delay as partial and padding events.
 *
 * Registered via mediaPlayer.extend('ScheduleController', DodgeScheduleControllerOverride, true).
 */

import { getDodgeDebug } from '../utils/DodgeDebug.js';
import { resolveNumericSetting } from '../utils/StrictMode.js';

function DodgeScheduleControllerOverride(config) {
    config = config || {};
    const context = this.context;
    const parent = this.parent;
    const _parentShouldClearScheduleTimer = parent._shouldClearScheduleTimer;
    const _parentStartScheduleTimer = parent.startScheduleTimer;

    const dashHandler = config.dashHandler;
    const bufferController = config.bufferController;
    const settings = config.settings;
    const streamInfo = config.streamInfo;
    const type = config.type;

    const logger = getDodgeDebug(context).getLogger({ __dashjs_factory_name: 'DodgeScheduleControllerOverride' });
    let warnedScheduleRandom = false;
    let warnedScheduleBase = false;

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

    /**
     * True when a download failure has permanently stalled this stream.
     *
     * Reached through the DodgeHandler the player registered on the context,
     * the same way DodgeGapControllerOverride reaches it. Absent when the
     * module is not registered, which is the vanilla case.
     */
    function _isStalled() {
        const dodgeHandler = context._dodgeHandler;
        return !!(dodgeHandler && dodgeHandler.isStalled && streamInfo &&
            dodgeHandler.isStalled(streamInfo.id, type));
    }

    function _shouldClearScheduleTimer() {
        // A stalled stream is finished, so this outranks both the parent's
        // verdict and the trailing keep-alive below. `_schedule` consults this
        // before it generates anything, so clearing here is what stops the next
        // cycle from going out. Enforcing it at the point of failure instead
        // would not hold: StreamProcessor restarts the timer for text on every
        // fragment completion, without reading the error or the sender.
        if (_isStalled()) {
            return true;
        }

        // Refresh the reported buffer level before anything reads it. The mock
        // buffer only reaches the scheduler through BUFFER_LEVEL_UPDATED, which
        // BufferController fires from its own _updateBufferLevel, and the only
        // callers of that are appends and the element's timeupdate.
        if (dashHandler && dashHandler.getIsTrailing && dashHandler.getIsTrailing() &&
                bufferController && bufferController.updateBufferLevel) {
            bufferController.updateBufferLevel();
        }

        const parentResult = _parentShouldClearScheduleTimer.call(parent);
        if (!parentResult) {
            return false;
        }

        // Keep scheduling during trailing phase even if the parent would stop.
        if (dashHandler && dashHandler.getIsTrailing && dashHandler.getIsTrailing()) {
            return false;
        }
        return true;
    }

    function startScheduleTimer(value) {
        if (dashHandler && dashHandler.getIsDefended && dashHandler.getIsDefended()) {
            const minDelay = _getScheduleWait();
            _parentStartScheduleTimer.call(parent, Math.max(value || 0, minDelay));
        } else {
            _parentStartScheduleTimer.call(parent, value);
        }
    }

    return {
        _shouldClearScheduleTimer,
        startScheduleTimer,
    };
}

export default DodgeScheduleControllerOverride;
