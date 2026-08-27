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


import DodgeConstants from '../../../../src/dodge/constants/DodgeConstants.js';
import { createStrictModeReader } from '../../../../src/dodge/utils/StrictMode.js';

import sinon from 'sinon';
import { expect } from 'chai';

const STRICT_MODE = DodgeConstants.STRICT_MODE;

function makeReader(strictMode) {
    const settings = { get: () => ({ dodge: { strictMode: strictMode } }) };
    const logger = { warn: sinon.spy() };
    return { read: createStrictModeReader(settings, logger), logger };
}

describe('Dodge StrictMode', function () {

    describe('accepted values pass through unchanged', function () {
        it('false is returned as the boolean, not coerced', function () {
            const { read, logger } = makeReader(false);
            expect(read()).to.equal(false);
            expect(logger.warn.called).to.be.false; // jshint ignore:line
        });

        ['representation', 'manifest', 'max'].forEach(function (mode) {
            it(mode + ' is returned unchanged', function () {
                const { read, logger } = makeReader(mode);
                expect(read()).to.equal(mode);
                expect(logger.warn.called).to.be.false; // jshint ignore:line
            });
        });
    });

    describe('unrecognized values fail closed to max', function () {
        const rejected = [
            ['wrong case', 'Manifest'],
            ['unknown token', 'strict'],
            ['trailing whitespace', 'representation '],
            ['boolean true', true],
            ['empty string', ''],
            ['zero', 0],
            ['null', null],
            ['undefined', undefined]
        ];

        rejected.forEach(function (entry) {
            it(entry[0] + ' becomes max', function () {
                const { read } = makeReader(entry[1]);
                expect(read()).to.equal(STRICT_MODE.MAX);
            });
        });

        it('a missing dodge settings block becomes max', function () {
            const settings = { get: () => ({}) };
            const read = createStrictModeReader(settings, { warn: sinon.spy() });
            expect(read()).to.equal(STRICT_MODE.MAX);
        });
    });

    describe('diagnostic', function () {
        it('names the setting, quotes the value, and states the fallback', function () {
            const { read, logger } = makeReader('representation ');
            read();
            expect(logger.warn.calledOnce).to.be.true; // jshint ignore:line
            const msg = logger.warn.firstCall.args[0];
            expect(msg).to.include('dodge.strictMode');
            // Quoted so a stray space is visible rather than invisible.
            expect(msg).to.include('"representation "');
            expect(msg).to.include('max');
        });

        it('warns once per reader, however many times it is read', function () {
            const { read, logger } = makeReader('strict');
            read(); read(); read();
            expect(logger.warn.calledOnce).to.be.true; // jshint ignore:line
        });

        // The flag lives in the reader's closure rather than at module scope,
        // so one consumer's warning cannot mask another's.
        it('each reader warns independently', function () {
            const first = makeReader('strict');
            const second = makeReader('strict');
            first.read();
            second.read();
            expect(first.logger.warn.calledOnce).to.be.true; // jshint ignore:line
            expect(second.logger.warn.calledOnce).to.be.true; // jshint ignore:line
        });
    });
});
