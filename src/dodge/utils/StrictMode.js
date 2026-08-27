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


import DodgeConstants from '../constants/DodgeConstants.js';

const ACCEPTED = [
    DodgeConstants.STRICT_MODE.NONE,
    DodgeConstants.STRICT_MODE.REPRESENTATION,
    DodgeConstants.STRICT_MODE.MANIFEST,
    DodgeConstants.STRICT_MODE.MAX
];

/**
 * Build a reader that resolves `dodge.strictMode` to one of the accepted
 * values, failing closed.
 *
 * strictMode is the module's master enforcement switch, and every consumer
 * compares it against exact tokens. An unrecognized value - a typo such as
 * 'Manifest' or 'representation ', or the boolean true - would compare unequal
 * to every strict token and so silently disable enforcement. Treat it as 'max'
 * instead, so a misconfiguration is loud rather than invisible.
 *
 * The warn-once flag lives in this closure rather than at module scope so that
 * each consumer gets its own, and so that tests do not have to reason about
 * which file ran first.
 *
 * @param {object} settings - Settings instance to read from.
 * @param {object} logger - Logger used to report an unrecognized value.
 * @returns {function(): (false|string)} Reader returning an accepted value.
 */
export function createStrictModeReader(settings, logger) {
    let warned = false;

    return function getStrictMode() {
        const raw = (settings.get().dodge || {}).strictMode;

        if (ACCEPTED.indexOf(raw) !== -1) {
            return raw;
        }

        if (!warned) {
            logger.warn('dodge.strictMode has an unrecognized value (' + JSON.stringify(raw) + '), treating as max - playback will abort on any source that is not fully defended');
            warned = true;
        }

        return DodgeConstants.STRICT_MODE.MAX;
    };
}
