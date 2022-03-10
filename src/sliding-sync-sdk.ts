/*
Copyright 2022 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { User, UserEvent } from "./models/user";
import { NotificationCountType, Room, RoomEvent } from "./models/room";
import * as utils from "./utils";
import { IDeferred } from "./utils";
import { EventTimeline } from "./models/event-timeline";
import { PushProcessor } from "./pushprocessor";
import { logger } from './logger';
import { InvalidStoreError } from './errors';
import { IAbortablePromise } from "./@types/partials";
import { ClientEvent, IStoredClientOpts, MatrixClient, PendingEventOrdering } from "./client";
import {
    IEphemeral,
    IInvitedRoom,
    IInviteState,
    IJoinedRoom,
    ILeftRoom,
    IMinimalEvent,
    IRoomEvent,
    IStateEvent,
    IStrippedState,
    ISyncResponse,
    ITimeline,
} from "./sync-accumulator";
import { MatrixEvent } from "./models/event";
import { MatrixError, Method } from "./http-api";
import { ISavedSync } from "./store";
import { EventType } from "./@types/event";
import { IPushRules } from "./@types/PushRules";
import { RoomStateEvent } from "./models/room-state";
import { RoomMemberEvent } from "./models/room-member";
import {SyncState } from "./sync";

const DEBUG = true;

const BUFFER_PERIOD_MS = 80 * 1000;

// Number of consecutive failed syncs that will lead to a syncState of ERROR as opposed
// to RECONNECTING. This is needed to inform the client of server issues when the
// keepAlive is successful but the server /sync fails.
const FAILED_SYNC_ERROR_THRESHOLD = 3;

function debuglog(...params) {
    if (!DEBUG) {
        return;
    }
    logger.log(...params);
}

interface ISyncOptions {
    filterId?: string;
    hasSyncedBefore?: boolean;
}

export interface ISyncStateData {
    error?: MatrixError;
    oldSyncToken?: string;
    nextSyncToken?: string;
    catchingUp?: boolean;
    fromCache?: boolean;
}

interface ISyncQueryParams {
    timeout: number;
    pos?: string;
    _cacheBuster?: string | number; // not part of the API itself
}

// http-api mangles an abort method onto its promises
interface IRequestPromise<T> extends Promise<T> {
    abort(): void;
}

type WrappedRoom<T> = T & {
    room: Room;
    isBrandNewRoom: boolean;
};

/**
 * <b>Internal class - unstable.</b>
 * Construct an entity which is able to sync with a homeserver.
 * @constructor
 * @param {MatrixClient} client The matrix client instance to use.
 * @param {Object} opts Config options
 * @param {module:crypto=} opts.crypto Crypto manager
 * @param {Function=} opts.canResetEntireTimeline A function which is called
 * with a room ID and returns a boolean. It should return 'true' if the SDK can
 * SAFELY remove events from this room. It may not be safe to remove events if
 * there are other references to the timelines for this room.
 * Default: returns false.
 * @param {Boolean=} opts.disablePresence True to perform syncing without automatically
 * updating presence.
 */
export class SlidingSyncApi {
    private currentSyncRequest: IRequestPromise<ISyncResponse> = null;
    private syncState: SyncState = null;
    private syncStateData: ISyncStateData = null; // additional data (eg. error object for failed sync)
    private catchingUp = false;
    private running = false;
    private keepAliveTimer: number = null;
    private connectionReturnedDefer: IDeferred<boolean> = null;
    private notifEvents: MatrixEvent[] = []; // accumulator of sync events in the current sync response
    private failedSyncCount = 0; // Number of consecutive failed /sync requests
    private storeIsInvalid = false; // flag set if the store needs to be cleared before we can start

    constructor(private readonly client: MatrixClient, private readonly opts: Partial<IStoredClientOpts> = {}) {
        this.opts.initialSyncLimit = this.opts.initialSyncLimit ?? 8;
        this.opts.resolveInvitesToProfiles = this.opts.resolveInvitesToProfiles || false;
        this.opts.pollTimeout = this.opts.pollTimeout || (30 * 1000);
        this.opts.pendingEventOrdering = this.opts.pendingEventOrdering || PendingEventOrdering.Chronological;
        this.opts.experimentalThreadSupport = this.opts.experimentalThreadSupport === true;

        if (!opts.canResetEntireTimeline) {
            opts.canResetEntireTimeline = (roomId: string) => {
                return false;
            };
        }

        if (client.getNotifTimelineSet()) {
            client.reEmitter.reEmit(client.getNotifTimelineSet(), [
                RoomEvent.Timeline,
                RoomEvent.TimelineReset,
            ]);
        }
    }

    /**
     * @param {string} roomId
     * @return {Room}
     */
    public createRoom(roomId: string): Room {
        const client = this.client;
        const {
            timelineSupport,
            unstableClientRelationAggregation,
        } = client;
        const room = new Room(roomId, client, client.getUserId(), {
            lazyLoadMembers: this.opts.lazyLoadMembers,
            pendingEventOrdering: this.opts.pendingEventOrdering,
            timelineSupport,
            unstableClientRelationAggregation,
        });
        client.reEmitter.reEmit(room, [
            RoomEvent.Name,
            RoomEvent.Redaction,
            RoomEvent.RedactionCancelled,
            RoomEvent.Receipt,
            RoomEvent.Tags,
            RoomEvent.LocalEchoUpdated,
            RoomEvent.AccountData,
            RoomEvent.MyMembership,
            RoomEvent.Timeline,
            RoomEvent.TimelineReset,
        ]);
        this.registerStateListeners(room);
        return room;
    }

    /**
     * @param {Room} room
     * @private
     */
    private registerStateListeners(room: Room): void {
        const client = this.client;
        // we need to also re-emit room state and room member events, so hook it up
        // to the client now. We need to add a listener for RoomState.members in
        // order to hook them correctly.
        client.reEmitter.reEmit(room.currentState, [
            RoomStateEvent.Events,
            RoomStateEvent.Members,
            RoomStateEvent.NewMember,
            RoomStateEvent.Update,
        ]);
        room.currentState.on(RoomStateEvent.NewMember, function(event, state, member) {
            member.user = client.getUser(member.userId);
            client.reEmitter.reEmit(member, [
                RoomMemberEvent.Name,
                RoomMemberEvent.Typing,
                RoomMemberEvent.PowerLevel,
                RoomMemberEvent.Membership,
            ]);
        });
    }

    /**
     * @param {Room} room
     * @private
     */
    private deregisterStateListeners(room: Room): void {
        // could do with a better way of achieving this.
        room.currentState.removeAllListeners(RoomStateEvent.Events);
        room.currentState.removeAllListeners(RoomStateEvent.Members);
        room.currentState.removeAllListeners(RoomStateEvent.NewMember);
    }

    /**
     * Sync rooms the user has left.
     * @return {Promise} Resolved when they've been added to the store.
     */
    public async syncLeftRooms() {
        return []; // TODO
    }

    /**
     * Peek into a room. This will result in the room in question being synced so it
     * is accessible via getRooms(). Live updates for the room will be provided.
     * @param {string} roomId The room ID to peek into.
     * @return {Promise} A promise which resolves once the room has been added to the
     * store.
     */
    public async peek(roomId: string): Promise<Room> {
        return null; // TODO
    }

    /**
     * Stop polling for updates in the peeked room. NOPs if there is no room being
     * peeked.
     */
    public stopPeeking(): void {
        // TODO
    }

    /**
     * Returns the current state of this sync object
     * @see module:client~MatrixClient#event:"sync"
     * @return {?String}
     */
    public getSyncState(): SyncState {
        return this.syncState;
    }

    /**
     * Returns the additional data object associated with
     * the current sync state, or null if there is no
     * such data.
     * Sync errors, if available, are put in the 'error' key of
     * this object.
     * @return {?Object}
     */
    public getSyncStateData(): ISyncStateData {
        return this.syncStateData;
    }

    public async recoverFromSyncStartupError(savedSyncPromise: Promise<void>, err: MatrixError): Promise<void> {
        // Wait for the saved sync to complete - we send the pushrules and filter requests
        // before the saved sync has finished so they can run in parallel, but only process
        // the results after the saved sync is done. Equivalently, we wait for it to finish
        // before reporting failures from these functions.
        await savedSyncPromise;
        const keepaliveProm = this.startKeepAlives();
        this.updateSyncState(SyncState.Error, { error: err });
        await keepaliveProm;
    }

    /**
     * Is the lazy loading option different than in previous session?
     * @param {boolean} lazyLoadMembers current options for lazy loading
     * @return {boolean} whether or not the option has changed compared to the previous session */
    private async wasLazyLoadingToggled(lazyLoadMembers = false): Promise<boolean> {
        // assume it was turned off before
        // if we don't know any better
        let lazyLoadMembersBefore = false;
        const isStoreNewlyCreated = await this.client.store.isNewlyCreated();
        if (!isStoreNewlyCreated) {
            const prevClientOptions = await this.client.store.getClientOptions();
            if (prevClientOptions) {
                lazyLoadMembersBefore = !!prevClientOptions.lazyLoadMembers;
            }
            return lazyLoadMembersBefore !== lazyLoadMembers;
        }
        return false;
    }

    private shouldAbortSync(error: MatrixError): boolean {
        if (error.errcode === "M_UNKNOWN_TOKEN") {
            // The logout already happened, we just need to stop.
            logger.warn("Token no longer valid - assuming logout");
            this.stop();
            this.updateSyncState(SyncState.Error, { error });
            return true;
        }
        return false;
    }

    /**
     * Main entry point
     */
    public sync(): void {
        const client = this.client;

        this.running = true;

        if (global.window && global.window.addEventListener) {
            global.window.addEventListener("online", this.onOnline, false);
        }

        let savedSyncPromise = Promise.resolve();
        let savedSyncToken = null;

        // We need to do one-off checks before we can begin the /sync loop.
        // These are:
        //   1) We need to get push rules so we can check if events should bing as we get
        //      them from /sync.
        //   2) We need to get/create a filter which we can use for /sync.
        //   3) We need to check the lazy loading option matches what was used in the
        //       stored sync. If it doesn't, we can't use the stored sync.

        const getPushRules = async () => {
            try {
                debuglog("Getting push rules...");
                const result = await client.getPushRules();
                debuglog("Got push rules");

                client.pushRules = result;
            } catch (err) {
                logger.error("Getting push rules failed", err);
                if (this.shouldAbortSync(err)) return;
                // wait for saved sync to complete before doing anything else,
                // otherwise the sync state will end up being incorrect
                debuglog("Waiting for saved sync before retrying push rules...");
                await this.recoverFromSyncStartupError(savedSyncPromise, err);
                getPushRules();
                return;
            }
            checkLazyLoadStatus(); // advance to the next stage
        };

        const checkLazyLoadStatus = async () => {
            debuglog("Checking lazy load status...");
            if (this.opts.lazyLoadMembers && client.isGuest()) {
                this.opts.lazyLoadMembers = false;
            }
            if (this.opts.lazyLoadMembers) {
                debuglog("Checking server lazy load support...");
                const supported = await client.doesServerSupportLazyLoading();
                if (supported) {
                    debuglog("Enabling lazy load on sync filter...");
                    this.opts.lazyLoadMembers = false; // TODO
                } else {
                    debuglog("LL: lazy loading requested but not supported " +
                        "by server, so disabling");
                    this.opts.lazyLoadMembers = false;
                }
            }
            // need to vape the store when enabling LL and wasn't enabled before
            debuglog("Checking whether lazy loading has changed in store...");
            const shouldClear = await this.wasLazyLoadingToggled(this.opts.lazyLoadMembers);
            if (shouldClear) {
                this.storeIsInvalid = true;
                const reason = InvalidStoreError.TOGGLED_LAZY_LOADING;
                const error = new InvalidStoreError(reason, !!this.opts.lazyLoadMembers);
                this.updateSyncState(SyncState.Error, { error });
                // bail out of the sync loop now: the app needs to respond to this error.
                // we leave the state as 'ERROR' which isn't great since this normally means
                // we're retrying. The client must be stopped before clearing the stores anyway
                // so the app should stop the client, clear the store and start it again.
                logger.warn("InvalidStoreError: store is not usable: stopping sync.");
                return;
            }
            if (this.opts.lazyLoadMembers && this.opts.crypto) {
                this.opts.crypto.enableLazyLoading();
            }
            try {
                debuglog("Storing client options...");
                await this.client.storeClientOptions();
                debuglog("Stored client options");
            } catch (err) {
                logger.error("Storing client options failed", err);
                throw err;
            }

            getFilter(); // Now get the filter and start syncing
        };

        const getFilter = async () => {
            debuglog("Getting filter...");
            // reset the notifications timeline to prepare it to paginate from
            // the current point in time.
            // The right solution would be to tie /sync pagination tokens into
            // /notifications API somehow.
            client.resetNotifTimelineSet();

            if (this.currentSyncRequest === null) {
                // Send this first sync request here so we can then wait for the saved
                // sync data to finish processing before we process the results of this one.
                debuglog("Sending first sync request...");
                this.currentSyncRequest = this.doSyncRequest({ }, savedSyncToken);
            }

            // Now wait for the saved sync to finish...
            debuglog("Waiting for saved sync before starting sync processing...");
            await savedSyncPromise;
            this.doSync({ });
        };

        if (client.isGuest()) {
            // no push rules for guests, no access to POST filter for guests.
            this.doSync({});
        } else {
            // Pull the saved sync token out first, before the worker starts sending
            // all the sync data which could take a while. This will let us send our
            // first incremental sync request before we've processed our saved data.
            debuglog("Getting saved sync token...");
            savedSyncPromise = client.store.getSavedSyncToken().then((tok) => {
                debuglog("Got saved sync token");
                savedSyncToken = tok;
                debuglog("Getting saved sync...");
                return client.store.getSavedSync();
            }).then((savedSync) => {
                debuglog(`Got reply from saved sync, exists? ${!!savedSync}`);
                if (savedSync) {
                    return this.syncFromCache(savedSync);
                }
            }).catch(err => {
                logger.error("Getting saved sync failed", err);
            });
            // Now start the first incremental sync request: this can also
            // take a while so if we set it going now, we can wait for it
            // to finish while we process our saved sync data.
            getPushRules();
        }
    }

    /**
     * Stops the sync object from syncing.
     */
    public stop(): void {
        debuglog("SyncApi.stop");
        // It is necessary to check for the existance of
        // global.window AND global.window.removeEventListener.
        // Some platforms (e.g. React Native) register global.window,
        // but do not have global.window.removeEventListener.
        if (global.window && global.window.removeEventListener) {
            global.window.removeEventListener("online", this.onOnline, false);
        }
        this.running = false;
        if (this.currentSyncRequest) {
            this.currentSyncRequest.abort();
        }
        if (this.keepAliveTimer) {
            clearTimeout(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    /**
     * Retry a backed off syncing request immediately. This should only be used when
     * the user <b>explicitly</b> attempts to retry their lost connection.
     * @return {boolean} True if this resulted in a request being retried.
     */
    public retryImmediately(): boolean {
        if (!this.connectionReturnedDefer) {
            return false;
        }
        this.startKeepAlives(0);
        return true;
    }
    /**
     * Process a single set of cached sync data.
     * @param {Object} savedSync a saved sync that was persisted by a store. This
     * should have been acquired via client.store.getSavedSync().
     */
    private async syncFromCache(savedSync: ISavedSync): Promise<void> {
        debuglog("sync(): not doing HTTP hit, instead returning stored /sync data");

        const nextSyncToken = savedSync.nextBatch;

        // Set sync token for future incremental syncing
        this.client.store.setSyncToken(nextSyncToken);

        // No previous sync, set old token to null
        const syncEventData = {
            oldSyncToken: null,
            nextSyncToken,
            catchingUp: false,
            fromCache: true,
        };

        const data: ISyncResponse = {
            next_batch: nextSyncToken,
            rooms: savedSync.roomsData,
            groups: savedSync.groupsData,
            account_data: {
                events: savedSync.accountData,
            },
        };

        try {
            await this.processSyncResponse(syncEventData, data);
        } catch (e) {
            logger.error("Error processing cached sync", e.stack || e);
        }

        // Don't emit a prepared if we've bailed because the store is invalid:
        // in this case the client will not be usable until stopped & restarted
        // so this would be useless and misleading.
        if (!this.storeIsInvalid) {
            this.updateSyncState(SyncState.Prepared, syncEventData);
        }
    }

    /**
     * Invoke me to do /sync calls
     * @param {Object} syncOptions
     * @param {string} syncOptions.filterId
     * @param {boolean} syncOptions.hasSyncedBefore
     */
    private async doSync(syncOptions: ISyncOptions): Promise<void> {
        const client = this.client;

        if (!this.running) {
            debuglog("Sync no longer running: exiting.");
            if (this.connectionReturnedDefer) {
                this.connectionReturnedDefer.reject();
                this.connectionReturnedDefer = null;
            }
            this.updateSyncState(SyncState.Stopped);
            return;
        }

        const syncToken = client.store.getSyncToken();

        let data;
        try {
            //debuglog('Starting sync since=' + syncToken);
            if (this.currentSyncRequest === null) {
                this.currentSyncRequest = this.doSyncRequest(syncOptions, syncToken);
            }
            data = await this.currentSyncRequest;
        } catch (e) {
            this.onSyncError(e, syncOptions);
            return;
        } finally {
            this.currentSyncRequest = null;
        }

        //debuglog('Completed sync, next_batch=' + data.next_batch);

        // set the sync token NOW *before* processing the events. We do this so
        // if something barfs on an event we can skip it rather than constantly
        // polling with the same token.
        client.store.setSyncToken(data.next_batch);

        // Reset after a successful sync
        this.failedSyncCount = 0;

        await client.store.setSyncData(data);

        const syncEventData = {
            oldSyncToken: syncToken,
            nextSyncToken: data.next_batch,
            catchingUp: this.catchingUp,
        };

        if (this.opts.crypto) {
            // tell the crypto module we're about to process a sync
            // response
            await this.opts.crypto.onSyncWillProcess(syncEventData);
        }

        try {
            await this.processSyncResponse(syncEventData, data);
        } catch (e) {
            // log the exception with stack if we have it, else fall back
            // to the plain description
            logger.error("Caught /sync error", e.stack || e);

            // Emit the exception for client handling
            this.client.emit(ClientEvent.SyncUnexpectedError, e);
        }

        // update this as it may have changed
        syncEventData.catchingUp = this.catchingUp;

        // emit synced events
        if (!syncOptions.hasSyncedBefore) {
            this.updateSyncState(SyncState.Prepared, syncEventData);
            syncOptions.hasSyncedBefore = true;
        }

        // tell the crypto module to do its processing. It may block (to do a
        // /keys/changes request).
        if (this.opts.crypto) {
            await this.opts.crypto.onSyncCompleted(syncEventData);
        }

        // keep emitting SYNCING -> SYNCING for clients who want to do bulk updates
        this.updateSyncState(SyncState.Syncing, syncEventData);

        if (client.store.wantsSave()) {
            // We always save the device list (if it's dirty) before saving the sync data:
            // this means we know the saved device list data is at least as fresh as the
            // stored sync data which means we don't have to worry that we may have missed
            // device changes. We can also skip the delay since we're not calling this very
            // frequently (and we don't really want to delay the sync for it).
            if (this.opts.crypto) {
                await this.opts.crypto.saveDeviceList(0);
            }

            // tell databases that everything is now in a consistent state and can be saved.
            client.store.save();
        }

        // Begin next sync
        this.doSync(syncOptions);
    }

    private doSyncRequest(syncOptions: ISyncOptions, pos: string): IRequestPromise<ISyncResponse> {
        const qps = this.getSyncQueryParams(syncOptions, pos);
        return this.client.http.authedRequest(
            undefined, Method.Get, "/sync", qps as any, undefined,
            {
                localTimeoutMs: qps.timeout + BUFFER_PERIOD_MS,
            },
        );
    }

    private getSyncQueryParams(syncOptions: ISyncOptions, pos: string): ISyncQueryParams {
        let pollTimeout = this.opts.pollTimeout;

        if (this.getSyncState() !== 'SYNCING' || this.catchingUp) {
            // unless we are happily syncing already, we want the server to return
            // as quickly as possible, even if there are no events queued. This
            // serves two purposes:
            //
            // * When the connection dies, we want to know asap when it comes back,
            //   so that we can hide the error from the user. (We don't want to
            //   have to wait for an event or a timeout).
            //
            // * We want to know if the server has any to_device messages queued up
            //   for us. We do that by calling it with a zero timeout until it
            //   doesn't give us any more to_device messages.
            this.catchingUp = true;
            pollTimeout = 0;
        }

        const qps: ISyncQueryParams = {
            timeout: pollTimeout,
        };

        if (pos) {
            qps.pos = pos;
        } else {
            // use a cachebuster for initialsyncs, to make sure that
            // we don't get a stale sync
            // (https://github.com/vector-im/vector-web/issues/1354)
            qps._cacheBuster = Date.now();
        }

        if (this.getSyncState() == 'ERROR' || this.getSyncState() == 'RECONNECTING') {
            // we think the connection is dead. If it comes back up, we won't know
            // about it till /sync returns. If the timeout= is high, this could
            // be a long time. Set it to 0 when doing retries so we don't have to wait
            // for an event or a timeout before emiting the SYNCING event.
            qps.timeout = 0;
        }

        return qps;
    }

    private onSyncError(err: MatrixError, syncOptions: ISyncOptions): void {
        if (!this.running) {
            debuglog("Sync no longer running: exiting");
            if (this.connectionReturnedDefer) {
                this.connectionReturnedDefer.reject();
                this.connectionReturnedDefer = null;
            }
            this.updateSyncState(SyncState.Stopped);
            return;
        }

        logger.error("/sync error %s", err);
        logger.error(err);

        if (this.shouldAbortSync(err)) {
            return;
        }

        this.failedSyncCount++;
        logger.log('Number of consecutive failed sync requests:', this.failedSyncCount);

        debuglog("Starting keep-alive");
        // Note that we do *not* mark the sync connection as
        // lost yet: we only do this if a keepalive poke
        // fails, since long lived HTTP connections will
        // go away sometimes and we shouldn't treat this as
        // erroneous. We set the state to 'reconnecting'
        // instead, so that clients can observe this state
        // if they wish.
        this.startKeepAlives().then((connDidFail) => {
            // Only emit CATCHUP if we detected a connectivity error: if we didn't,
            // it's quite likely the sync will fail again for the same reason and we
            // want to stay in ERROR rather than keep flip-flopping between ERROR
            // and CATCHUP.
            if (connDidFail && this.getSyncState() === SyncState.Error) {
                this.updateSyncState(SyncState.Catchup, {
                    oldSyncToken: null,
                    nextSyncToken: null,
                    catchingUp: true,
                });
            }
            this.doSync(syncOptions);
        });

        this.currentSyncRequest = null;
        // Transition from RECONNECTING to ERROR after a given number of failed syncs
        this.updateSyncState(
            this.failedSyncCount >= FAILED_SYNC_ERROR_THRESHOLD ?
                SyncState.Error : SyncState.Reconnecting,
            { error: err },
        );
    }

    /**
     * Process data returned from a sync response and propagate it
     * into the model objects
     *
     * @param {Object} syncEventData Object containing sync tokens associated with this sync
     * @param {Object} data The response from /sync
     */
    private async processSyncResponse(syncEventData: ISyncStateData, data: ISyncResponse): Promise<void> {
        const client = this.client;

        // data looks like:
        // {
        // }

        // handle presence events (User objects)
        if (data.presence && Array.isArray(data.presence.events)) {
            data.presence.events.map(client.getEventMapper()).forEach(
                function(presenceEvent) {
                    let user = client.store.getUser(presenceEvent.getSender());
                    if (user) {
                        user.setPresenceEvent(presenceEvent);
                    } else {
                        user = createNewUser(client, presenceEvent.getSender());
                        user.setPresenceEvent(presenceEvent);
                        client.store.storeUser(user);
                    }
                    client.emit(ClientEvent.Event, presenceEvent);
                });
        }

        // handle non-room account_data
        if (data.account_data && Array.isArray(data.account_data.events)) {
            const events = data.account_data.events.map(client.getEventMapper());
            const prevEventsMap = events.reduce((m, c) => {
                m[c.getId()] = client.store.getAccountData(c.getType());
                return m;
            }, {});
            client.store.storeAccountDataEvents(events);
            events.forEach(
                function(accountDataEvent) {
                    // Honour push rules that come down the sync stream but also
                    // honour push rules that were previously cached. Base rules
                    // will be updated when we receive push rules via getPushRules
                    // (see sync) before syncing over the network.
                    if (accountDataEvent.getType() === EventType.PushRules) {
                        const rules = accountDataEvent.getContent<IPushRules>();
                        client.pushRules = PushProcessor.rewriteDefaultRules(rules);
                    }
                    const prevEvent = prevEventsMap[accountDataEvent.getId()];
                    client.emit(ClientEvent.AccountData, accountDataEvent, prevEvent);
                    return accountDataEvent;
                },
            );
        }

        // handle to-device events
        if (data.to_device && Array.isArray(data.to_device.events) &&
            data.to_device.events.length > 0
        ) {
            const cancelledKeyVerificationTxns = [];
            data.to_device.events
                .map(client.getEventMapper())
                .map((toDeviceEvent) => { // map is a cheap inline forEach
                    // We want to flag m.key.verification.start events as cancelled
                    // if there's an accompanying m.key.verification.cancel event, so
                    // we pull out the transaction IDs from the cancellation events
                    // so we can flag the verification events as cancelled in the loop
                    // below.
                    if (toDeviceEvent.getType() === "m.key.verification.cancel") {
                        const txnId = toDeviceEvent.getContent()['transaction_id'];
                        if (txnId) {
                            cancelledKeyVerificationTxns.push(txnId);
                        }
                    }

                    // as mentioned above, .map is a cheap inline forEach, so return
                    // the unmodified event.
                    return toDeviceEvent;
                })
                .forEach(
                    function(toDeviceEvent) {
                        const content = toDeviceEvent.getContent();
                        if (
                            toDeviceEvent.getType() == "m.room.message" &&
                            content.msgtype == "m.bad.encrypted"
                        ) {
                            // the mapper already logged a warning.
                            logger.log(
                                'Ignoring undecryptable to-device event from ' +
                                toDeviceEvent.getSender(),
                            );
                            return;
                        }

                        if (toDeviceEvent.getType() === "m.key.verification.start"
                            || toDeviceEvent.getType() === "m.key.verification.request") {
                            const txnId = content['transaction_id'];
                            if (cancelledKeyVerificationTxns.includes(txnId)) {
                                toDeviceEvent.flagCancelled();
                            }
                        }

                        client.emit(ClientEvent.ToDeviceEvent, toDeviceEvent);
                    },
                );
        } else {
            // no more to-device events: we can stop polling with a short timeout.
            this.catchingUp = false;
        }

        // the returned json structure is a bit crap, so make it into a
        // nicer form (array) after applying sanity to make sure we don't fail
        // on missing keys (on the off chance)
        let inviteRooms: WrappedRoom<IInvitedRoom>[] = [];
        let joinRooms: WrappedRoom<IJoinedRoom>[] = [];
        let leaveRooms: WrappedRoom<ILeftRoom>[] = [];

        if (data.rooms) {
            if (data.rooms.invite) {
                inviteRooms = this.mapSyncResponseToRoomArray(data.rooms.invite);
            }
            if (data.rooms.join) {
                joinRooms = this.mapSyncResponseToRoomArray(data.rooms.join);
            }
            if (data.rooms.leave) {
                leaveRooms = this.mapSyncResponseToRoomArray(data.rooms.leave);
            }
        }

        this.notifEvents = [];

        // Handle invites
        inviteRooms.forEach((inviteObj) => {
            const room = inviteObj.room;
            const stateEvents = this.mapSyncEventsFormat(inviteObj.invite_state, room);

            this.processRoomEvents(room, stateEvents);
            if (inviteObj.isBrandNewRoom) {
                room.recalculate();
                client.store.storeRoom(room);
                client.emit(ClientEvent.Room, room);
            }
            stateEvents.forEach(function(e) {
                client.emit(ClientEvent.Event, e);
            });
            room.updateMyMembership("invite");
        });

        // Handle joins
        await utils.promiseMapSeries(joinRooms, async (joinObj) => {
            const room = joinObj.room;
            const stateEvents = this.mapSyncEventsFormat(joinObj.state, room);
            // Prevent events from being decrypted ahead of time
            // this helps large account to speed up faster
            // room::decryptCriticalEvent is in charge of decrypting all the events
            // required for a client to function properly
            const events = this.mapSyncEventsFormat(joinObj.timeline, room, false);
            const ephemeralEvents = this.mapSyncEventsFormat(joinObj.ephemeral);
            const accountDataEvents = this.mapSyncEventsFormat(joinObj.account_data);

            const encrypted = client.isRoomEncrypted(room.roomId);
            // we do this first so it's correct when any of the events fire
            if (joinObj.unread_notifications) {
                room.setUnreadNotificationCount(
                    NotificationCountType.Total,
                    joinObj.unread_notifications.notification_count,
                );

                // We track unread notifications ourselves in encrypted rooms, so don't
                // bother setting it here. We trust our calculations better than the
                // server's for this case, and therefore will assume that our non-zero
                // count is accurate.
                if (!encrypted
                    || (encrypted && room.getUnreadNotificationCount(NotificationCountType.Highlight) <= 0)) {
                    room.setUnreadNotificationCount(
                        NotificationCountType.Highlight,
                        joinObj.unread_notifications.highlight_count,
                    );
                }
            }

            joinObj.timeline = joinObj.timeline || {} as ITimeline;

            if (joinObj.isBrandNewRoom) {
                // set the back-pagination token. Do this *before* adding any
                // events so that clients can start back-paginating.
                room.getLiveTimeline().setPaginationToken(
                    joinObj.timeline.prev_batch, EventTimeline.BACKWARDS);
            } else if (joinObj.timeline.limited) {
                let limited = true;

                // we've got a limited sync, so we *probably* have a gap in the
                // timeline, so should reset. But we might have been peeking or
                // paginating and already have some of the events, in which
                // case we just want to append any subsequent events to the end
                // of the existing timeline.
                //
                // This is particularly important in the case that we already have
                // *all* of the events in the timeline - in that case, if we reset
                // the timeline, we'll end up with an entirely empty timeline,
                // which we'll try to paginate but not get any new events (which
                // will stop us linking the empty timeline into the chain).
                //
                for (let i = events.length - 1; i >= 0; i--) {
                    const eventId = events[i].getId();
                    if (room.getTimelineForEvent(eventId)) {
                        debuglog("Already have event " + eventId + " in limited " +
                            "sync - not resetting");
                        limited = false;

                        // we might still be missing some of the events before i;
                        // we don't want to be adding them to the end of the
                        // timeline because that would put them out of order.
                        events.splice(0, i);

                        // XXX: there's a problem here if the skipped part of the
                        // timeline modifies the state set in stateEvents, because
                        // we'll end up using the state from stateEvents rather
                        // than the later state from timelineEvents. We probably
                        // need to wind stateEvents forward over the events we're
                        // skipping.

                        break;
                    }
                }

                if (limited) {
                    this.deregisterStateListeners(room);
                    room.resetLiveTimeline(
                        joinObj.timeline.prev_batch,
                        this.opts.canResetEntireTimeline(room.roomId) ?
                            null : syncEventData.oldSyncToken,
                    );

                    // We have to assume any gap in any timeline is
                    // reason to stop incrementally tracking notifications and
                    // reset the timeline.
                    client.resetNotifTimelineSet();

                    this.registerStateListeners(room);
                }
            }

            const [timelineEvents, threadedEvents] = this.client.partitionThreadedEvents(events);

            this.processRoomEvents(room, stateEvents, timelineEvents, syncEventData.fromCache);

            // set summary after processing events,
            // because it will trigger a name calculation
            // which needs the room state to be up to date
            if (joinObj.summary) {
                room.setSummary(joinObj.summary);
            }

            // we deliberately don't add ephemeral events to the timeline
            room.addEphemeralEvents(ephemeralEvents);

            // we deliberately don't add accountData to the timeline
            room.addAccountData(accountDataEvents);

            room.recalculate();
            if (joinObj.isBrandNewRoom) {
                client.store.storeRoom(room);
                client.emit(ClientEvent.Room, room);
            }

            this.processEventsForNotifs(room, events);

            const processRoomEvent = async (e) => {
                client.emit(ClientEvent.Event, e);
                if (e.isState() && e.getType() == "m.room.encryption" && this.opts.crypto) {
                    await this.opts.crypto.onCryptoEvent(e);
                }
                if (e.isState() && e.getType() === "im.vector.user_status") {
                    let user = client.store.getUser(e.getStateKey());
                    if (user) {
                        user.unstable_updateStatusMessage(e);
                    } else {
                        user = createNewUser(client, e.getStateKey());
                        user.unstable_updateStatusMessage(e);
                        client.store.storeUser(user);
                    }
                }
            };

            await utils.promiseMapSeries(stateEvents, processRoomEvent);
            await utils.promiseMapSeries(timelineEvents, processRoomEvent);
            await utils.promiseMapSeries(threadedEvents, processRoomEvent);
            ephemeralEvents.forEach(function(e) {
                client.emit(ClientEvent.Event, e);
            });
            accountDataEvents.forEach(function(e) {
                client.emit(ClientEvent.Event, e);
            });

            room.updateMyMembership("join");

            // Decrypt only the last message in all rooms to make sure we can generate a preview
            // And decrypt all events after the recorded read receipt to ensure an accurate
            // notification count
            room.decryptCriticalEvents();
        });

        // Handle leaves (e.g. kicked rooms)
        leaveRooms.forEach(async (leaveObj) => {
            const room = leaveObj.room;
            const stateEvents = this.mapSyncEventsFormat(leaveObj.state, room);
            const events = this.mapSyncEventsFormat(leaveObj.timeline, room);
            const accountDataEvents = this.mapSyncEventsFormat(leaveObj.account_data);

            const [timelineEvents, threadedEvents] = this.client.partitionThreadedEvents(events);

            this.processRoomEvents(room, stateEvents, timelineEvents);
            room.addAccountData(accountDataEvents);

            room.recalculate();
            if (leaveObj.isBrandNewRoom) {
                client.store.storeRoom(room);
                client.emit(ClientEvent.Room, room);
            }

            this.processEventsForNotifs(room, events);

            stateEvents.forEach(function(e) {
                client.emit(ClientEvent.Event, e);
            });
            timelineEvents.forEach(function(e) {
                client.emit(ClientEvent.Event, e);
            });
            threadedEvents.forEach(function(e) {
                client.emit(ClientEvent.Event, e);
            });
            accountDataEvents.forEach(function(e) {
                client.emit(ClientEvent.Event, e);
            });

            room.updateMyMembership("leave");
        });

        // update the notification timeline, if appropriate.
        // we only do this for live events, as otherwise we can't order them sanely
        // in the timeline relative to ones paginated in by /notifications.
        // XXX: we could fix this by making EventTimeline support chronological
        // ordering... but it doesn't, right now.
        if (syncEventData.oldSyncToken && this.notifEvents.length) {
            this.notifEvents.sort(function(a, b) {
                return a.getTs() - b.getTs();
            });
            this.notifEvents.forEach(function(event) {
                client.getNotifTimelineSet().addLiveEvent(event);
            });
        }

        // Handle device list updates
        if (data.device_lists) {
            if (this.opts.crypto) {
                await this.opts.crypto.handleDeviceListChanges(syncEventData, data.device_lists);
            } else {
                // FIXME if we *don't* have a crypto module, we still need to
                // invalidate the device lists. But that would require a
                // substantial bit of rework :/.
            }
        }

        // Handle one_time_keys_count
        if (this.opts.crypto && data.device_one_time_keys_count) {
            const currentCount = data.device_one_time_keys_count.signed_curve25519 || 0;
            this.opts.crypto.updateOneTimeKeyCount(currentCount);
        }
        if (this.opts.crypto &&
            (data["device_unused_fallback_key_types"] ||
                data["org.matrix.msc2732.device_unused_fallback_key_types"])) {
            // The presence of device_unused_fallback_key_types indicates that the
            // server supports fallback keys. If there's no unused
            // signed_curve25519 fallback key we need a new one.
            const unusedFallbackKeys = data["device_unused_fallback_key_types"] ||
                data["org.matrix.msc2732.device_unused_fallback_key_types"];
            this.opts.crypto.setNeedsNewFallback(
                unusedFallbackKeys instanceof Array &&
                !unusedFallbackKeys.includes("signed_curve25519"),
            );
        }
    }

    /**
     * Starts polling the connectivity check endpoint
     * @param {number} delay How long to delay until the first poll.
     *        defaults to a short, randomised interval (to prevent
     *        tightlooping if /versions succeeds but /sync etc. fail).
     * @return {promise} which resolves once the connection returns
     */
    private startKeepAlives(delay?: number): Promise<boolean> {
        if (delay === undefined) {
            delay = 2000 + Math.floor(Math.random() * 5000);
        }

        if (this.keepAliveTimer !== null) {
            clearTimeout(this.keepAliveTimer);
        }
        if (delay > 0) {
            this.keepAliveTimer = setTimeout(this.pokeKeepAlive.bind(this), delay);
        } else {
            this.pokeKeepAlive();
        }
        if (!this.connectionReturnedDefer) {
            this.connectionReturnedDefer = utils.defer();
        }
        return this.connectionReturnedDefer.promise;
    }

    /**
     * Make a dummy call to /_matrix/client/versions, to see if the HS is
     * reachable.
     *
     * On failure, schedules a call back to itself. On success, resolves
     * this.connectionReturnedDefer.
     *
     * @param {boolean} connDidFail True if a connectivity failure has been detected. Optional.
     */
    private pokeKeepAlive(connDidFail = false): void {
        const success = () => {
            clearTimeout(this.keepAliveTimer);
            if (this.connectionReturnedDefer) {
                this.connectionReturnedDefer.resolve(connDidFail);
                this.connectionReturnedDefer = null;
            }
        };

        this.client.http.request(
            undefined, // callback
            Method.Get, "/_matrix/client/versions",
            undefined, // queryParams
            undefined, // data
            {
                prefix: '',
                localTimeoutMs: 15 * 1000,
            },
        ).then(() => {
            success();
        }, (err) => {
            if (err.httpStatus == 400 || err.httpStatus == 404) {
                // treat this as a success because the server probably just doesn't
                // support /versions: point is, we're getting a response.
                // We wait a short time though, just in case somehow the server
                // is in a mode where it 400s /versions responses and sync etc.
                // responses fail, this will mean we don't hammer in a loop.
                this.keepAliveTimer = setTimeout(success, 2000);
            } else {
                connDidFail = true;
                this.keepAliveTimer = setTimeout(
                    this.pokeKeepAlive.bind(this, connDidFail),
                    5000 + Math.floor(Math.random() * 5000),
                );
                // A keepalive has failed, so we emit the
                // error state (whether or not this is the
                // first failure).
                // Note we do this after setting the timer:
                // this lets the unit tests advance the mock
                // clock when they get the error.
                this.updateSyncState(SyncState.Error, { error: err });
            }
        });
    }

    /**
     * @param {Object} obj
     * @return {Object[]}
     */
    private mapSyncResponseToRoomArray<T extends ILeftRoom | IJoinedRoom | IInvitedRoom>(
        obj: Record<string, T>,
    ): Array<WrappedRoom<T>> {
        // Maps { roomid: {stuff}, roomid: {stuff} }
        // to
        // [{stuff+Room+isBrandNewRoom}, {stuff+Room+isBrandNewRoom}]
        const client = this.client;
        return Object.keys(obj).map((roomId) => {
            const arrObj = obj[roomId] as T & { room: Room, isBrandNewRoom: boolean };
            let room = client.store.getRoom(roomId);
            let isBrandNewRoom = false;
            if (!room) {
                room = this.createRoom(roomId);
                isBrandNewRoom = true;
            }
            arrObj.room = room;
            arrObj.isBrandNewRoom = isBrandNewRoom;
            return arrObj;
        });
    }

    /**
     * @param {Object} obj
     * @param {Room} room
     * @param {boolean} decrypt
     * @return {MatrixEvent[]}
     */
    private mapSyncEventsFormat(
        obj: IInviteState | ITimeline | IEphemeral,
        room?: Room,
        decrypt = true,
    ): MatrixEvent[] {
        if (!obj || !Array.isArray(obj.events)) {
            return [];
        }
        const mapper = this.client.getEventMapper({ decrypt });
        return (obj.events as Array<IStrippedState | IRoomEvent | IStateEvent | IMinimalEvent>).map(function(e) {
            if (room) {
                e["room_id"] = room.roomId;
            }
            return mapper(e);
        });
    }

    /**
     * @param {Room} room
     */
    private resolveInvites(room: Room): void {
        if (!room || !this.opts.resolveInvitesToProfiles) {
            return;
        }
        const client = this.client;
        // For each invited room member we want to give them a displayname/avatar url
        // if they have one (the m.room.member invites don't contain this).
        room.getMembersWithMembership("invite").forEach(function(member) {
            if (member._requestedProfileInfo) return;
            member._requestedProfileInfo = true;
            // try to get a cached copy first.
            const user = client.getUser(member.userId);
            let promise;
            if (user) {
                promise = Promise.resolve({
                    avatar_url: user.avatarUrl,
                    displayname: user.displayName,
                });
            } else {
                promise = client.getProfileInfo(member.userId);
            }
            promise.then(function(info) {
                // slightly naughty by doctoring the invite event but this means all
                // the code paths remain the same between invite/join display name stuff
                // which is a worthy trade-off for some minor pollution.
                const inviteEvent = member.events.member;
                if (inviteEvent.getContent().membership !== "invite") {
                    // between resolving and now they have since joined, so don't clobber
                    return;
                }
                inviteEvent.getContent().avatar_url = info.avatar_url;
                inviteEvent.getContent().displayname = info.displayname;
                // fire listeners
                member.setMembershipEvent(inviteEvent, room.currentState);
            }, function(err) {
                // OH WELL.
            });
        });
    }

    /**
     * @param {Room} room
     * @param {MatrixEvent[]} stateEventList A list of state events. This is the state
     * at the *START* of the timeline list if it is supplied.
     * @param {MatrixEvent[]} [timelineEventList] A list of timeline events. Lower index
     * @param {boolean} fromCache whether the sync response came from cache
     * is earlier in time. Higher index is later.
     */
    private processRoomEvents(
        room: Room,
        stateEventList: MatrixEvent[],
        timelineEventList?: MatrixEvent[],
        fromCache = false,
    ): void {
        // If there are no events in the timeline yet, initialise it with
        // the given state events
        const liveTimeline = room.getLiveTimeline();
        const timelineWasEmpty = liveTimeline.getEvents().length == 0;
        if (timelineWasEmpty) {
            // Passing these events into initialiseState will freeze them, so we need
            // to compute and cache the push actions for them now, otherwise sync dies
            // with an attempt to assign to read only property.
            // XXX: This is pretty horrible and is assuming all sorts of behaviour from
            // these functions that it shouldn't be. We should probably either store the
            // push actions cache elsewhere so we can freeze MatrixEvents, or otherwise
            // find some solution where MatrixEvents are immutable but allow for a cache
            // field.
            for (const ev of stateEventList) {
                this.client.getPushActionsForEvent(ev);
            }
            liveTimeline.initialiseState(stateEventList);
        }

        this.resolveInvites(room);

        // recalculate the room name at this point as adding events to the timeline
        // may make notifications appear which should have the right name.
        // XXX: This looks suspect: we'll end up recalculating the room once here
        // and then again after adding events (processSyncResponse calls it after
        // calling us) even if no state events were added. It also means that if
        // one of the room events in timelineEventList is something that needs
        // a recalculation (like m.room.name) we won't recalculate until we've
        // finished adding all the events, which will cause the notification to have
        // the old room name rather than the new one.
        room.recalculate();

        // If the timeline wasn't empty, we process the state events here: they're
        // defined as updates to the state before the start of the timeline, so this
        // starts to roll the state forward.
        // XXX: That's what we *should* do, but this can happen if we were previously
        // peeking in a room, in which case we obviously do *not* want to add the
        // state events here onto the end of the timeline. Historically, the js-sdk
        // has just set these new state events on the old and new state. This seems
        // very wrong because there could be events in the timeline that diverge the
        // state, in which case this is going to leave things out of sync. However,
        // for now I think it;s best to behave the same as the code has done previously.
        if (!timelineWasEmpty) {
            // XXX: As above, don't do this...
            //room.addLiveEvents(stateEventList || []);
            // Do this instead...
            room.oldState.setStateEvents(stateEventList || []);
            room.currentState.setStateEvents(stateEventList || []);
        }
        // execute the timeline events. This will continue to diverge the current state
        // if the timeline has any state events in it.
        // This also needs to be done before running push rules on the events as they need
        // to be decorated with sender etc.
        room.addLiveEvents(timelineEventList || [], null, fromCache);
    }

    /**
     * Takes a list of timelineEvents and adds and adds to notifEvents
     * as appropriate.
     * This must be called after the room the events belong to has been stored.
     *
     * @param {Room} room
     * @param {MatrixEvent[]} [timelineEventList] A list of timeline events. Lower index
     * is earlier in time. Higher index is later.
     */
    private processEventsForNotifs(room: Room, timelineEventList: MatrixEvent[]): void {
        // gather our notifications into this.notifEvents
        if (this.client.getNotifTimelineSet()) {
            for (let i = 0; i < timelineEventList.length; i++) {
                const pushActions = this.client.getPushActionsForEvent(timelineEventList[i]);
                if (pushActions && pushActions.notify &&
                    pushActions.tweaks && pushActions.tweaks.highlight) {
                    this.notifEvents.push(timelineEventList[i]);
                }
            }
        }
    }

    /**
     * Sets the sync state and emits an event to say so
     * @param {String} newState The new state string
     * @param {Object} data Object of additional data to emit in the event
     */
    private updateSyncState(newState: SyncState, data?: ISyncStateData): void {
        const old = this.syncState;
        this.syncState = newState;
        this.syncStateData = data;
        this.client.emit(ClientEvent.Sync, this.syncState, old, data);
    }

    /**
     * Event handler for the 'online' event
     * This event is generally unreliable and precise behaviour
     * varies between browsers, so we poll for connectivity too,
     * but this might help us reconnect a little faster.
     */
    private onOnline = (): void => {
        debuglog("Browser thinks we are back online");
        this.startKeepAlives(0);
    };
}

function createNewUser(client: MatrixClient, userId: string): User {
    const user = new User(userId);
    client.reEmitter.reEmit(user, [
        UserEvent.AvatarUrl,
        UserEvent.DisplayName,
        UserEvent.Presence,
        UserEvent.CurrentlyActive,
        UserEvent.LastPresenceTs,
    ]);
    return user;
}