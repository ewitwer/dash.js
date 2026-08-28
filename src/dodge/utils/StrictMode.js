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
 * Readers for the `dodge` settings block. Every setting here is one that
 * can be set wrong in a way that removes a defense while playback continues
 * normally, so each reader validates rather than coerces, and resolves an
 * unusable value to the safest one rather than to the configured one.
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

/**
 * Render a rejected value for a log message. Numbers are printed as-is so
 * NaN and Infinity read as themselves; JSON.stringify would turn both into
 * `null`. Everything else is quoted, so the string '1024' is distinguishable
 * from the number 1024 in the log.
 *
 * @param {*} raw - The rejected value.
 * @returns {string} Printable form.
 */
function _describe(raw) {
    if (typeof raw === 'number') {
        return String(raw);
    }
    const json = JSON.stringify(raw);
    return json === undefined ? String(raw) : json;
}

/**
 * Resolve one numeric `dodge` setting to a usable non-negative number.
 *
 * The caller owns the warn-once flag, so that one consumer's warning cannot
 * mask another's.
 *
 * @param {object} settings - Settings instance to read from.
 * @param {string} name - Key within the `dodge` settings block.
 * @returns {{value: number, valid: boolean, message: (string|null)}} Resolved
 *          value, whether the configured value was usable, and the warning to
 *          log when it was not.
 */
export function resolveNumericSetting(settings, name) {
    const raw = (settings.get().dodge || {})[name];
    const valid = typeof raw === 'number' && isFinite(raw) && raw >= 0;

    return {
        value: valid ? raw : 0,
        valid: valid,
        message: valid ? null :
            'dodge.' + name + ' is not a non-negative number (' + _describe(raw) + '), treating as 0'
    };
}
