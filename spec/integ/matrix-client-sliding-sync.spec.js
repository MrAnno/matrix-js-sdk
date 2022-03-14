import { SlidingSync, SlidingSyncState, SlidingList } from "../../src/sliding-sync";
import { TestClient } from "../TestClient";

describe("SlidingSync", () => {
    let client = null;
    let httpBackend = null;
    const selfUserId = "@alice:localhost";
    const selfAccessToken = "aseukfgwef";
    const proxyBaseUrl = "http://localhost:8008";
    const syncUrl = proxyBaseUrl + "/_matrix/client/unstable/org.matrix.msc3575/sync"

    beforeEach(() => {
        const testClient = new TestClient(selfUserId, "DEVICE", selfAccessToken);
        httpBackend = testClient.httpBackend;
        client = testClient.client;
    });

    afterEach(() => {
        httpBackend.verifyNoOutstandingExpectation();
        client.stopClient();
        return httpBackend.stop();
    });

    describe("start/stop", () => {
        it("should start the sync loop upon calling start() and stop it upon calling stop()", async (done) => {
            const slidingSync = new SlidingSync(proxyBaseUrl, [], {}, client, 1);
            const fakeResp = {
                pos: "a",
                ops: [],
                counts: [],
                room_subscriptions: {},
            };
            httpBackend.when("POST", syncUrl).respond(200, fakeResp);
            let p = listenUntil(slidingSync, "SlidingSync.Lifecycle", (state, resp, err) => {
                expect(state).toEqual(SlidingSyncState.RequestFinished);
                expect(resp).toEqual(fakeResp);
                expect(err).toBeFalsy();
                return true;
            });
            slidingSync.start();
            await httpBackend.flush(syncUrl, 1);
            await p;
            slidingSync.stop();
            done();
        });
    });

    describe("room subscriptions", () => {
        const roomId = "!foo:bar";
        const roomSubInfo = {
            timeline_limit: 1,
            required_state: [
                ["m.room.name", ""],
            ]
        };
        const wantRoomData = {
            name: "foo bar",
            room_id: roomId,
            required_state: [],
            timeline: [],
        };

        it("should be able to subscribe/unsubscribe to a room", async (done) => {    
            // add the subscription
            const slidingSync = new SlidingSync(proxyBaseUrl, [], roomSubInfo, client, 1);
            slidingSync.modifyRoomSubscriptions(new Set([roomId]));
            const fakeResp = {
                pos: "a",
                ops: [],
                counts: [],
                room_subscriptions: {
                    [roomId]: wantRoomData
                },
            };
            httpBackend.when("POST", syncUrl).check(function(req) {
                let body = req.data;
                if (!body) {
                    body = JSON.parse(req.opts.body);
                }
                console.log(body);
                expect(body.room_subscriptions).toBeTruthy();
                expect(body.room_subscriptions[roomId]).toEqual(roomSubInfo);
            }).respond(200, fakeResp);

            let p = listenUntil(slidingSync, "SlidingSync.RoomData", (gotRoomId, gotRoomData) => {
                expect(gotRoomId).toEqual(roomId);
                expect(gotRoomData).toEqual(wantRoomData);
                return true;
            });
            slidingSync.start();
            await httpBackend.flush(syncUrl, 1);
            await p;

            httpBackend.when("POST", syncUrl).check(function(req) {
                let body = req.data;
                if (!body) {
                    body = JSON.parse(req.opts.body);
                }
                console.log("2", body);
                expect(body.room_subscriptions).toBeFalsy();
                expect(body.unsubscribe_rooms).toEqual([roomId]);
            }).respond(200, fakeResp);
        
            p = listenUntil(slidingSync, "SlidingSync.Lifecycle", (state) => {
                return state === SlidingSyncState.Complete;
            });
        
            // remove the subscription
            slidingSync.modifyRoomSubscriptions(new Set());
        
            // kick the connection to resend the unsub
            slidingSync.resend();
            await httpBackend.flush(syncUrl, 2); // flush 2, the one made before the req change and the req change
            await p;
            slidingSync.stop();
            done();
        });

        it("should be possible to adjust room subscription info whislt syncing", () => {
            // add 1 sync, modify info, sync, check it is resent
        });
        it("should be possible to add room subscriptions whilst syncing", () => {
            // add 1, sync, add 1, sync, check only 1 is sent
        });
    });

    describe("lists", () => {
        it("should be possible to subscribe to a list", async (done) => {
            // request first 3 rooms
            let listReq = {
                ranges:  [[0,2]],
                sort: ["by_name"],
                timeline_limit: 1,
                required_state: [
                    ["m.room.topic", ""],
                ],
                filters: {
                    is_dm: true,
                },
            };
            const slidingSync = new SlidingSync(proxyBaseUrl, [listReq], {}, client, 1);
            const roomA = "!a:localhost";
            const roomB = "!b:localhost";
            const roomC = "!c:localhost";
            const rooms = [
                {
                    room_id: roomA,
                    name: "A",
                    required_state: [],
                    timeline: [],
                },
                {
                    room_id: roomB,
                    name: "B",
                    required_state: [],
                    timeline: [],
                },
                {
                    room_id: roomC,
                    name: "C",
                    required_state: [],
                    timeline: [],
                },
            ]
            httpBackend.when("POST", syncUrl).check(function(req) {
                let body = req.data;
                if (!body) {
                    body = JSON.parse(req.opts.body);
                }
                console.log(body);
                expect(body.lists).toBeTruthy();
                expect(body.lists[0]).toEqual(listReq);
            }).respond(200, {
                pos: "a",
                ops: [{
                    op: "SYNC",
                    list: 0,
                    range: [0,2],
                    rooms: rooms,
                }],
                counts: [500],
            });
            let listenerData = {};
            slidingSync.on("SlidingSync.RoomData", (roomId, roomData) => {
                expect(listenerData[roomId]).toBeFalsy();
                listenerData[roomId] = roomData;
            });
            let responseProcessed = listenUntil(slidingSync, "SlidingSync.Lifecycle", (state) => {
                return state === SlidingSyncState.Complete;
            })
            slidingSync.start();
            await httpBackend.flush(syncUrl, 1);
            await responseProcessed;

            expect(listenerData[roomA]).toEqual(rooms[0]);
            expect(listenerData[roomB]).toEqual(rooms[1]);
            expect(listenerData[roomC]).toEqual(rooms[2]);
            slidingSync.stop();
            done();
        });

        it("should be possible to adjust list ranges", () => {
            // make 1 list, modify range, check it gets submitted
        });

        it("should be possible to get list updates", () => {
            // make 2 lists, issue INSERT, check right one gets updated with right values
        });

    });
});

function timeout(delayMs, reason) {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            reject(`timeout: ${delayMs}ms - ${reason}`);
        }, delayMs);
    });
}

/**
 * Listen until a callback returns data.
 * @param {EventEmitter} emitter The event emitter
 * @param {string} eventName The event to listen for
 * @param {function} callback The callback which will be invoked when events fire. Return something truthy from this to resolve the promise.
 * @param {number} timeoutMs The number of milliseconds to wait for the callback to return data. Default: 500ms.
 * @returns A promise which will be resolved when the callback returns data. If the callback throws or the timeout is reached,
 * the promise is rejected.
 */
function listenUntil(emitter, eventName, callback, timeoutMs) {
    if (!timeoutMs) {
        timeoutMs = 500;
    }
    return Promise.race([new Promise((resolve, reject) => {
        const wrapper = (...args) => {
            try {
                const data = callback(...args)
                if (data) {
                    emitter.off(eventName, wrapper);
                    resolve(data);
                }
            } catch (err) {
                reject(err);
            }
        }
        emitter.on(eventName, wrapper);
    }), timeout(timeoutMs, "timed out waiting for event " + eventName)]);
}