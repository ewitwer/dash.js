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
            // The refusal itself cannot be asserted directly here. DodgeHandler
            // names the uncovered representation in an error log, but a Dodge log
            // message never reaches the player's LOG event, and the strict mode
            // error never reaches the public ERROR event either, because
            // ManifestUpdater forwards only parsing failures to the error
            // handler. What an application can observe is what is pinned below.
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

        it(`No segments are requested for any representation`, async () => {
            const traffic = await trafficPromise;

            // The whole source is refused at load time, so unlike a per
            // representation block there is no bounded leak of defended video
            // before the session goes quiet. Nothing at all is fetched.
            expect(traffic.length).to.equal(0, 'Expected no segment requests from a refused extended manifest');
        })
    })
})
