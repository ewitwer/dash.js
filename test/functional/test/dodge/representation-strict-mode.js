import Constants from '../../src/Constants.js';
import {expect} from 'chai';
import Utils from '../../src/Utils.js';

import {
    checkIsNotProgressing,
    initializeDashJsAdapter,
    playForDuration
} from '../common/common.js';

const TESTCASE = Constants.TESTCASES.DODGE.REPRESENTATION_STRICT_MODE;

// How long the source is given to load and be refused. Long enough for the
// extended manifest to be fetched and the gate to run, and long enough that a
// segment request escaping before the refusal would land inside the window.
const LOAD_ATTEMPT_MS = 8000;

// Mirrors src/dodge/errors/DodgeErrors.js. The functional tests run against the
// built bundle rather than the sources, so the value is repeated here.
const DODGE_STRICT_MODE_ERROR_CODE = 300;

Utils.getTestvectorsForTestcase(TESTCASE).forEach((item) => {
    const mpd = item.url;

    describe(`${TESTCASE} - ${item.name} - ${mpd}`, () => {
        let playerAdapter;
        let trafficPromise;

        before(async () => {
            // This extended manifest defends all three video representations and
            // leaves the audio representation the MPD declares with no entry.
            // Under the default strictMode 'representation' that is not a
            // partially defended source, it is a refused one: the load time gate
            // rejects any extended manifest that leaves a representation reaching
            // DashHandler uncovered, so no stream processor is ever built and
            // nothing is fetched. A plain MPD is unaffected, since it carries no
            // extended manifest for the gate to check, which is what separates
            // 'representation' from 'manifest'.
            //
            // A refusal reaches the application two ways, and both are pinned
            // below: the Dodge strict mode error on the player's ERROR event, and
            // the error log naming which representation was left out.
            playerAdapter = initializeDashJsAdapter(item, mpd);

            trafficPromise = playerAdapter.collectDodgeTraffic(LOAD_ATTEMPT_MS);

            await playForDuration(LOAD_ATTEMPT_MS);
        })

        after(() => {
            if (playerAdapter) {
                playerAdapter.destroy();
            }
        })

        it(`Dodge defense is not active (the extended manifest leaves audio uncovered)`, () => {
            const isActive = playerAdapter.isDodgeActive();
            expect(isActive).to.be.false;
        })

        it(`Playback should not progress`, async () => {
            await checkIsNotProgressing(playerAdapter);
        })

        it(`The refusal is reported to the application as a Dodge strict mode error`, () => {
            const errors = playerAdapter.getErrorEvents();
            const codes = errors.map(e => e.error && e.error.code);
            expect(codes).to.include(DODGE_STRICT_MODE_ERROR_CODE,
                'Expected a Dodge strict mode error on the player, saw ' + JSON.stringify(codes));
        })

        it(`The refusal names the representation that has no entry`, () => {
            const errors = playerAdapter.getLogEvents()[dashjs.Debug.LOG_LEVEL_ERROR]; // jshint ignore:line
            const namesTheGap = errors.some(
                message => message.indexOf('bbb_a64k') !== -1 &&
                    message.indexOf('no defended stream info') !== -1
            );
            expect(namesTheGap, 'Dodge error log was ' + JSON.stringify(errors)).to.be.true; // jshint ignore:line
        })

        it(`No segments are requested for any representation`, async () => {
            const traffic = await trafficPromise;

            // The whole source is refused at load time, so unlike a per
            // representation block there is no bounded leak of defended video
            // before the session goes quiet. Nothing at all is fetched.
            expect(traffic.length).to.equal(0, 'Expected no segment requests from a refused extended manifest');
        })
    })
})
