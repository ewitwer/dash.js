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

import Debug from '../../core/Debug.js';

/**
 * Where the Dodge modules get their logger.
 *
 * Dodge ships as its own bundle, `dash.dodge`, built from a separate webpack
 * entry with no externals, so it carries private copies of the dash.js core
 * modules. One of them is `FactoryMaker`, which means a `Debug(context)` call
 * made from inside this bundle looks up a singleton registry that the player
 * never wrote to. It finds nothing, builds a fresh `Debug` with no `settings`,
 * and every `doLog` on it then fails both of its own guards: nothing is written
 * to the console, and no LOG event is dispatched.
 *
 * `DodgeHandler` therefore takes the player's own `Debug` from `getDebug()` and
 * records it here, keyed by the context it belongs to so that two players on a
 * page keep their own log levels. Everything else in the bundle reads it back.
 */
const injected = new WeakMap();

/**
 * Record the player's Debug instance for this context.
 * @param {Object} context - The MediaPlayer context Dodge was created with.
 * @param {Object} debug - The player's Debug instance.
 */
export function setDodgeDebug(context, debug) {
    injected.set(context, debug);
}

/**
 * The Debug instance the Dodge modules should log through.
 * @param {Object} context - The MediaPlayer context.
 * @returns {Object} The player's Debug instance, or this bundle's own.
 */
export function getDodgeDebug(context) {
    return injected.get(context) || Debug(context).getInstance();
}
