import Constants from '../../src/Constants.js';
import Utils from '../../src/Utils.js';

import {
    checkIsNotProgressing,
    checkIsPlaying,
    checkIsProgressing,
    checkNoCriticalErrors,
    initializeDashJsAdapter,
    playForDuration
} from '../common/common.js';

import {
    checkDodgeActive,
    checkDodgeNotActive,
    defendedSettings
} from '../common/dodge.js';

const TESTCASE = Constants.TESTCASES.DODGE.POLICY_STRICT_MODE;

// Long enough for the manifest to be fetched and the load time gate to run, and
// long enough that a segment request escaping before a refusal would land inside
// the window.
const LOAD_ATTEMPT_MS = 8000;

/**
 * `strictMode: 'manifest'` asks one question of a source: does it carry an
 * extended manifest? A plain MPD is refused, an extended manifest is allowed.
 * Both halves of that rule are asserted here, against whichever kind of source
 * the vector is, so the two cases stay in one place and cannot drift apart.
 */
function isExtendedManifest(url) {
    return url.indexOf('.exmfst.json') !== -1;
}

Utils.getTestvectorsForTestcase(TESTCASE).forEach((item) => {
    const mpd = item.url;
    const extended = isExtendedManifest(mpd);

    describe(`${TESTCASE} - ${item.name} - ${mpd}`, () => {

        describe(`with strictMode manifest`, () => {
            let playerAdapter;

            before(async () => {
                playerAdapter = initializeDashJsAdapter(item, mpd,
                    defendedSettings({ dodge: { strictMode: 'manifest' } }));
                await playForDuration(LOAD_ATTEMPT_MS);
            })

            after(() => {
                if (playerAdapter) {
                    playerAdapter.destroy();
                }
            })

            if (extended) {
                it(`Dodge defense is active`, async () => {
                    await checkDodgeActive(playerAdapter);
                })

                it(`Checking playing state`, async () => {
                    await checkIsPlaying(playerAdapter, true);
                })

                it(`Checking progressing state`, async () => {
                    await checkIsProgressing(playerAdapter);
                })

                it(`Expect no critical errors to be thrown`, () => {
                    checkNoCriticalErrors(playerAdapter);
                })
            } else {
                it(`Dodge defense is not active on a source with no extended manifest`, () => {
                    checkDodgeNotActive(playerAdapter);
                })

                it(`Playback should not progress`, async () => {
                    await checkIsNotProgressing(playerAdapter);
                })
            }
        })

        // The same sources under the default mode, which asks about
        // representations rather than about the manifest. A plain MPD carries
        // no extended manifest for the gate to check, so it falls back to vanilla
        // dash.js and plays undefended. That difference is the whole distinction
        // between 'representation' and 'manifest'.
        if (!extended) {
            describe(`with the default strict mode`, () => {
                let playerAdapter;

                before(() => {
                    playerAdapter = initializeDashJsAdapter(item, mpd);
                })

                after(() => {
                    if (playerAdapter) {
                        playerAdapter.destroy();
                    }
                })

                it(`Checking playing state`, async () => {
                    await checkIsPlaying(playerAdapter, true);
                })

                it(`Dodge defense is not active`, () => {
                    checkDodgeNotActive(playerAdapter);
                })

                it(`Checking progressing state`, async () => {
                    await checkIsProgressing(playerAdapter);
                })

                it(`Expect no critical errors to be thrown`, () => {
                    checkNoCriticalErrors(playerAdapter);
                })
            })
        }
    })
})
