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
import { createStrictModeReader, resolveNumericSetting } from '../../../../src/dodge/utils/StrictMode.js';

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

function resolve(value) {
    const settings = { get: () => ({ dodge: { paddingLengthBase: value } }) };
    return resolveNumericSetting(settings, 'paddingLengthBase');
}

describe('Dodge numeric settings', function () {

    describe('non-negative finite numbers pass through unchanged', function () {
        [0, 1, 32, 1024, 0.5].forEach(function (value) {
            it(value + ' is returned unchanged with no message', function () {
                const result = resolve(value);
                expect(result.value).to.equal(value);
                expect(result.valid).to.be.true; // jshint ignore:line
                expect(result.message).to.be.null; // jshint ignore:line
            });
        });
    });

    describe('unusable values resolve to 0', function () {
        // Every entry here reaches the arithmetic as NaN or as a negative
        // number, and every consumer of these settings then silently stops
        // defending: no padding, no scheduling delay.
        const rejected = [
            ['negative', -1],
            ['NaN', NaN],
            ['Infinity', Infinity],
            ['-Infinity', -Infinity],
            // A quoted number is the most likely misconfiguration of all, and
            // the one a coercing resolver would wave through.
            ['numeric string', '1024'],
            ['non-numeric string', 'abc'],
            ['empty string', ''],
            ['null', null],
            ['undefined', undefined],
            ['boolean true', true],
            ['object', {}],
            // Number([]) is 0 and Number(['1024']) is 1024, so an array must be
            // rejected on its type rather than on its coerced value.
            ['empty array', []],
            ['single-element array', ['1024']]
        ];

        rejected.forEach(function (entry) {
            it(entry[0] + ' resolves to 0 and is reported as invalid', function () {
                const result = resolve(entry[1]);
                expect(result.value).to.equal(0);
                expect(result.valid).to.be.false; // jshint ignore:line
                expect(result.message).to.be.a('string');
            });
        });

        it('a missing dodge settings block resolves to 0', function () {
            const result = resolveNumericSetting({ get: () => ({}) }, 'paddingLengthBase');
            expect(result.value).to.equal(0);
            expect(result.valid).to.be.false; // jshint ignore:line
        });
    });

    describe('diagnostic message', function () {
        it('names the setting and states the fallback', function () {
            const message = resolve('abc').message;
            expect(message).to.include('dodge.paddingLengthBase');
            expect(message).to.include('treating as 0');
        });

        it('quotes a string value so it is distinguishable from the number', function () {
            expect(resolve('1024').message).to.include('"1024"');
        });

        it('shows NaN as NaN rather than as null', function () {
            const message = resolve(NaN).message;
            expect(message).to.include('NaN');
            expect(message).to.not.include('null');
        });

        it('reads the setting named in the call, not a fixed one', function () {
            const settings = { get: () => ({ dodge: { scheduleWaitBase: 'abc', paddingLengthBase: 1024 } }) };
            const result = resolveNumericSetting(settings, 'scheduleWaitBase');
            expect(result.valid).to.be.false; // jshint ignore:line
            expect(result.message).to.include('dodge.scheduleWaitBase');
        });
    });
});
