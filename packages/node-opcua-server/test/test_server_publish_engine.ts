/* eslint-disable import/order */
/**
 *
 *  OPCUA protocol defines a long-pooling mechanism for sending server-triggered events back to the client.
 *  Therefore the Publish service behalves slightly differently from other OPCUA services:
 *    - the client will send Publish requests to the server without expecting an immediate answer from the server.
 *    - The server will block the request until some subscriptions have some available data, or a time out
 *
 *
 *    - the Publish Request message is also used by the client to acknowledge processing of notification messages
 *
 *
 *    A good algorithm for a client is to send more publish request than live subscription.
 *
 *   - Publish Request are not tied to a particular subscription, the Server will use the oldest pending
 *     client Publish request to send some notification regarding the notifying subscription.
 *
 * preventing queue overflow
 * -------------------------
 *  - if the client send too many publish requests that the server can queue, the server may return a Service result
 *    of BadTooManyPublishRequests.
 *
 * Keep alive mechanism:
 * ---------------------
 *    Publish Request/Response are also use as a keep alive signal between the server and the client.
 *    Every publish request  is a live ping from the client to the server.
 *    Every publish response is a live ping from the server to the client.
 *
 *    If no notification are available after the keep-alive timeout interval, the server shall return an empty
 *    PublishResponse and therefore notifies the client about a valid connection.
 *    Similarly, the client shall send Publish Request
 *
 *
 */

import sinon from "sinon";
import should from "should";

import { PublishRequest, PublishResponse } from "node-opcua-service-subscription";
import { StatusCodes } from "node-opcua-status-code";
import { SessionContext } from "node-opcua-address-space";
import { ServerSidePublishEngine, Subscription, SubscriptionOptions, SubscriptionState } from "../source";

const property = (key: string) => (obj: Record<string,any>) => obj[key];

// tslint:disable-next-line: no-var-requires
const { add_mock_monitored_item } = require("./helper");

function makeSubscription(options: SubscriptionOptions) {
    const subscription1 = new Subscription(options);
    (subscription1 as any).$session = {
        sessionContext: SessionContext.defaultContext
    };
    return subscription1;
}

// tslint:disable-next-line: no-var-requires
const describe = require("node-opcua-leak-detector").describeWithLeakDetector;
describe("Testing the server publish engine", function (this: any) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const test = this;

    beforeEach(() => {
        test.clock = sinon.useFakeTimers();
    });

    afterEach(() => {
        test.clock.restore();
    });
    function flushPending() {
        test.clock.tick(0);
    }
    it("ZDZ-3 a server should send keep alive notifications", () => {
        function pulse(nbInterval: number) {
            for (let i = 0; i < nbInterval; i++) {
                test.clock.tick(subscription.publishingInterval);
            }
        }

        const publish_server = new ServerSidePublishEngine({});

        const subscription = makeSubscription({
            id: 1234,
            publishingInterval: 1000,
            lifeTimeCount: 1000,
            maxKeepAliveCount: 20,
            //
            publishEngine: publish_server,
            globalCounter: { totalMonitoredItemCount: 0 },
            serverCapabilities: { maxMonitoredItems: 10, maxMonitoredItemsPerSubscription: 10 }
        });

        publish_server.add_subscription(subscription);
        try {
            subscription.state.should.equal(SubscriptionState.CREATING);

            test.clock.tick(subscription.publishingInterval * subscription.maxKeepAliveCount);
            subscription.state.should.equal(SubscriptionState.LATE);

            // client sends a PublishRequest to the server
            const fakeRequest1 = new PublishRequest({ subscriptionAcknowledgements: [] });
            publish_server._on_PublishRequest(fakeRequest1);
            flushPending();

            // publish request should be consumed immediately as subscription is late.
            publish_server.pendingPublishRequestCount.should.equal(0);
            subscription.state.should.equal(SubscriptionState.KEEPALIVE);

            const fakeRequest2 = new PublishRequest({ subscriptionAcknowledgements: [] });
            publish_server._on_PublishRequest(fakeRequest2);
            flushPending();

            publish_server.pendingPublishRequestCount.should.equal(1);

            pulse(19);
            publish_server.pendingPublishRequestCount.should.equal(1);
            subscription.state.should.equal(SubscriptionState.KEEPALIVE);

            pulse(5);
            publish_server.pendingPublishRequestCount.should.equal(0);
            subscription.state.should.equal(SubscriptionState.KEEPALIVE);

            pulse(20);
            publish_server.pendingPublishRequestCount.should.equal(0);
            subscription.state.should.equal(SubscriptionState.LATE);
        } finally {
            subscription.terminate();
            subscription.dispose();
            publish_server.shutdown();
            publish_server.dispose();
        }
    });

    it("ZDZ-4 a server should feed the availableSequenceNumbers in PublishResponse with sequence numbers that have not been acknowledged by the client", () => {
        const serverSidePublishEngine = new ServerSidePublishEngine({});
        const send_response_for_request_spy = sinon.spy(serverSidePublishEngine, "_send_response_for_request");

        const subscription = makeSubscription({
            id: 1234,
            publishingInterval: 1000,
            lifeTimeCount: 1000,
            maxKeepAliveCount: 20,
            //
            publishEngine: serverSidePublishEngine,
            globalCounter: { totalMonitoredItemCount: 0 },
            serverCapabilities: { maxMonitoredItems: 10000, maxMonitoredItemsPerSubscription: 1000 }
        });
        serverSidePublishEngine.add_subscription(subscription);

        try {
            subscription.state.should.equal(SubscriptionState.CREATING);
            send_response_for_request_spy.callCount.should.equal(0);

            const monitoredItem = add_mock_monitored_item(subscription);

            // server send a notification to the client
            monitoredItem.simulateMonitoredItemAddingNotification();

            // client sends a PublishRequest to the server
            const fakeRequest1 = new PublishRequest({ subscriptionAcknowledgements: [] });
            serverSidePublishEngine._on_PublishRequest(fakeRequest1);

            test.clock.tick(subscription.publishingInterval);
            send_response_for_request_spy.callCount.should.equal(1); // initial still

            test.clock.tick(subscription.publishingInterval * 1.2);

            // server should send a response for the first publish request with the above notification
            // in this response, there should be  one element in the availableSequenceNumbers.
            send_response_for_request_spy.callCount.should.equal(1);

            // console.log( send_response_for_request_spy.getCall(0).args[1].toString());

            send_response_for_request_spy.getCall(0).args[1].schema.name.should.equal("PublishResponse");

            let response = send_response_for_request_spy.getCall(0).args[1] as PublishResponse;
            response.subscriptionId.should.eql(1234);
            response.availableSequenceNumbers!.should.eql([1]);

            // client sends a PublishRequest to the server ( with no acknowledgement)
            const fakeRequest2 = new PublishRequest({ subscriptionAcknowledgements: [] });
            serverSidePublishEngine._on_PublishRequest(fakeRequest2);
            flushPending();

            // server has now some notification ready and send them to the client
            monitoredItem.simulateMonitoredItemAddingNotification();
            send_response_for_request_spy.callCount.should.equal(1);

            test.clock.tick(subscription.publishingInterval);

            // server should send an response for the second publish request with a notification
            send_response_for_request_spy.callCount.should.equal(2);
            send_response_for_request_spy.getCall(1).args[1].schema.name.should.equal("PublishResponse");
            response = send_response_for_request_spy.getCall(1).args[1] as PublishResponse;
            response.subscriptionId.should.eql(1234);
            response.availableSequenceNumbers!.should.eql([1, 2]);
        } finally {
            // send_response_for_request_spy.
            subscription.terminate();
            subscription.dispose();
            serverSidePublishEngine.shutdown();
            serverSidePublishEngine.dispose();
        }
    });

    it("ZDZ-5 a server should return ServiceFault(BadNoSubscription) as a response for a publish Request if there is no subscription available for this session. ", () => {
        // create a server - server has no subscription
        const publish_server = new ServerSidePublishEngine();
        try {
            const send_response_for_request_spy = sinon.spy(publish_server, "_send_response_for_request");

            // client sends a PublishRequest to the server
            const fakeRequest1 = new PublishRequest({
                subscriptionAcknowledgements: []
            });
            publish_server._on_PublishRequest(fakeRequest1);
            flushPending();

            send_response_for_request_spy.callCount.should.equal(1);
            send_response_for_request_spy.getCall(0).args[1].schema.name.should.equal("ServiceFault");
            send_response_for_request_spy.getCall(0).args[1].responseHeader.serviceResult.should.eql(StatusCodes.BadNoSubscription);
        } finally {
            publish_server.shutdown();
            publish_server.dispose();
        }
    });

    it("ZDZ-6 should be possible to find a subscription by id on a publish_server", () => {
        const publish_server = new ServerSidePublishEngine({});
        publish_server.subscriptionCount.should.equal(0);

        const subscription = makeSubscription({
            id: 1234,
            publishingInterval: 1000, // 1 second
            lifeTimeCount: 100,
            maxKeepAliveCount: 20,
            //
            publishEngine: publish_server,
            globalCounter: { totalMonitoredItemCount: 0 },
            serverCapabilities: { maxMonitoredItems: 10000, maxMonitoredItemsPerSubscription: 1000 }
        });
        try {
            publish_server.add_subscription(subscription);
            publish_server.subscriptionCount.should.equal(1);
            publish_server.getSubscriptionById(1234).should.equal(subscription);
        } finally {
            subscription.terminate();
            subscription.dispose();

            publish_server.shutdown();
            publish_server.subscriptionCount.should.equal(0);
            publish_server.dispose();
        }
    });

    it("ZDZ-7 should be possible to remove a subscription from a publish_server", () => {
        const publish_server = new ServerSidePublishEngine({});
        publish_server.subscriptionCount.should.equal(0);

        const subscription = makeSubscription({
            id: 1234,
            publishingInterval: 1000,
            lifeTimeCount: 1000,
            maxKeepAliveCount: 20,
            //
            publishEngine: publish_server,
            globalCounter: { totalMonitoredItemCount: 0 },
            serverCapabilities: { maxMonitoredItems: 10000, maxMonitoredItemsPerSubscription: 1000 }
        });
        try {
            publish_server.add_subscription(subscription);
            publish_server.subscriptionCount.should.equal(1);
        } finally {
            subscription.terminate();
            subscription.dispose();
            publish_server.shutdown();
            publish_server.subscriptionCount.should.equal(0);
            publish_server.dispose();
        }
    });

    it("ZDZ-8 when the client send too many publish requests that the server can queue, the server returns a Service result of BadTooManyPublishRequests", () => {
        // When a Server receives a new Publish request that exceeds its limit it shall de-queue the oldest Publish
        // request and return a response with the result set to Bad_TooManyPublishRequests.

        const publish_server = new ServerSidePublishEngine({
            maxPublishRequestInQueue: 5
        });
        const send_response_for_request_spy = sinon.spy(publish_server, "_send_response_for_request");

        const subscription = makeSubscription({
            id: 1,
            publishingInterval: 10000,
            maxKeepAliveCount: 500,
            lifeTimeCount: 2000,
            publishEngine: publish_server,
            globalCounter: { totalMonitoredItemCount: 0 },
            serverCapabilities: { maxMonitoredItems: 10000, maxMonitoredItemsPerSubscription: 1000 }
        });
        publish_server.add_subscription(subscription);

        try {
            // simulate client sending PublishRequest ,and server doing nothing
            publish_server._on_PublishRequest(new PublishRequest({ requestHeader: { requestHandle: 1 } }));
            flushPending();

            test.clock.tick(subscription.publishingInterval);
            send_response_for_request_spy.callCount.should.be.equal(1);

            test.clock.tick(subscription.publishingInterval * (subscription.maxKeepAliveCount - 2));
            send_response_for_request_spy.callCount.should.be.equal(1);

            send_response_for_request_spy.getCall(0).args[1].schema.name.should.equal("PublishResponse");
            const response = send_response_for_request_spy.getCall(0).args[1] as PublishResponse;
            response.responseHeader.serviceResult.should.eql(StatusCodes.Good);
            response.responseHeader.requestHandle.should.eql(1);
            response.results!.should.eql([]);

            publish_server._on_PublishRequest(new PublishRequest({ requestHeader: { requestHandle: 2 } }));
            publish_server._on_PublishRequest(new PublishRequest({ requestHeader: { requestHandle: 3 } }));
            publish_server._on_PublishRequest(new PublishRequest({ requestHeader: { requestHandle: 4 } }));
            publish_server._on_PublishRequest(new PublishRequest({ requestHeader: { requestHandle: 5 } }));
            publish_server._on_PublishRequest(new PublishRequest({ requestHeader: { requestHandle: 6 } }));
            flushPending();

            // en: the straw that broke the camel's back.
            // cSpell:disable
            // fr: la goute qui fait déborder le vase.
            publish_server._on_PublishRequest(new PublishRequest({ requestHeader: { requestHandle: 7 } }));
            flushPending();

            send_response_for_request_spy.callCount.should.be.equal(2);

            // xx console.log(send_response_for_request_spy.getCall(0).args[1].responseHeader.toString());
            // xx console.log(send_response_for_request_spy.getCall(1).args[1].responseHeader.toString());

            send_response_for_request_spy.getCall(1).args[1].schema.name.should.equal("ServiceFault");
            send_response_for_request_spy
                .getCall(1)
                .args[1].responseHeader.serviceResult.should.eql(StatusCodes.BadTooManyPublishRequests);
            send_response_for_request_spy.getCall(1).args[1].responseHeader.requestHandle.should.eql(2);

            publish_server._on_PublishRequest(new PublishRequest({ requestHeader: { requestHandle: 8 } }));
            flushPending();

            send_response_for_request_spy.callCount.should.be.equal(3);
            // xx console.log(send_response_for_request_spy.getCall(2).args[1].responseHeader.toString());
            send_response_for_request_spy.getCall(2).args[1].schema.name.should.equal("ServiceFault");
            send_response_for_request_spy
                .getCall(2)
                .args[1].responseHeader.serviceResult.should.eql(StatusCodes.BadTooManyPublishRequests);
            send_response_for_request_spy.getCall(2).args[1].responseHeader.requestHandle.should.eql(3);
        } finally {
            subscription.terminate();
            subscription.dispose();
            publish_server.shutdown();
            publish_server.dispose();
        }
    });

    // eslint-disable-next-line max-statements
    it("ZDZ-9 the server shall process the client acknowledge sequence number", () => {
        const publish_server = new ServerSidePublishEngine();
        const send_response_for_request_spy = sinon.spy(publish_server, "_send_response_for_request");

        const subscription = makeSubscription({
            id: 1234,
            publishingInterval: 1000,
            lifeTimeCount: 1000,
            maxKeepAliveCount: 20,
            //
            publishEngine: publish_server,
            globalCounter: { totalMonitoredItemCount: 0 },
            serverCapabilities: { maxMonitoredItems: 10000, maxMonitoredItemsPerSubscription: 1000 }
        });
        publish_server.add_subscription(subscription);
        const monitoredItem = add_mock_monitored_item(subscription);
        try {
            // --------------------------------
            publish_server._on_PublishRequest(new PublishRequest());
            flushPending();

            // server send a notification to the client
            monitoredItem.simulateMonitoredItemAddingNotification();

            test.clock.tick(subscription.publishingInterval);

            subscription.getAvailableSequenceNumbers().should.eql([1]);

            send_response_for_request_spy.callCount.should.equal(1);
            send_response_for_request_spy.getCall(0).args[1].schema.name.should.equal("PublishResponse");

            let response = send_response_for_request_spy.getCall(0).args[1] as PublishResponse;
            response.responseHeader.serviceResult.should.eql(StatusCodes.Good);
            response.results!.should.eql([]);

            // --------------------------------
            publish_server._on_PublishRequest(new PublishRequest());
            flushPending();

            monitoredItem.simulateMonitoredItemAddingNotification();

            test.clock.tick(subscription.publishingInterval);

            subscription.getAvailableSequenceNumbers().should.eql([1, 2]);

            send_response_for_request_spy.callCount.should.equal(2);
            send_response_for_request_spy.getCall(1).args[1].schema.name.should.equal("PublishResponse");
            response = send_response_for_request_spy.getCall(1).args[1] as PublishResponse;
            response.responseHeader.serviceResult.should.eql(StatusCodes.Good);
            response.results!.should.eql([]);

            publish_server._on_PublishRequest(new PublishRequest());
            flushPending();

            monitoredItem.simulateMonitoredItemAddingNotification();

            test.clock.tick(subscription.publishingInterval);
            subscription.getAvailableSequenceNumbers().should.eql([1, 2, 3]);

            send_response_for_request_spy.callCount.should.equal(3);
            send_response_for_request_spy.getCall(2).args[1].schema.name.should.equal("PublishResponse");
            response = send_response_for_request_spy.getCall(2).args[1] as PublishResponse;
            response.responseHeader.serviceResult.should.eql(StatusCodes.Good);
            response.results!.should.eql([]);

            publish_server._on_PublishRequest(
                new PublishRequest({
                    subscriptionAcknowledgements: [{ subscriptionId: 1234, sequenceNumber: 2 }]
                })
            );
            flushPending();

            subscription.getAvailableSequenceNumbers().should.eql([1, 3, 4]);

            monitoredItem.simulateMonitoredItemAddingNotification();

            test.clock.tick(subscription.publishingInterval);
            send_response_for_request_spy.callCount.should.equal(4);
            send_response_for_request_spy.getCall(3).args[1].schema.name.should.equal("PublishResponse");
            response = send_response_for_request_spy.getCall(3).args[1] as PublishResponse;
            response.responseHeader.serviceResult.should.eql(StatusCodes.Good);
            response.results!.should.eql([StatusCodes.Good]);

            publish_server._on_PublishRequest(
                new PublishRequest({
                    subscriptionAcknowledgements: [
                        { subscriptionId: 1234, sequenceNumber: 1 },
                        { subscriptionId: 1234, sequenceNumber: 3 }
                    ]
                })
            );
            flushPending();

            subscription.getAvailableSequenceNumbers().should.eql([4, 5]);

            monitoredItem.simulateMonitoredItemAddingNotification();

            test.clock.tick(subscription.publishingInterval);

            send_response_for_request_spy.callCount.should.equal(5);
            send_response_for_request_spy.getCall(4).args[1].schema.name.should.equal("PublishResponse");
            response = send_response_for_request_spy.getCall(4).args[1] as PublishResponse;
            response.responseHeader.serviceResult.should.eql(StatusCodes.Good);
            response.results!.should.eql([StatusCodes.Good, StatusCodes.Good]);
        } finally {
            subscription.terminate();
            subscription.dispose();
            publish_server.shutdown();
            publish_server.dispose();
        }
    });

    it("ZDZ-A the server shall return BadSequenceNumberInvalid if the client attempts to acknowledge a notification that is not in the queue", () => {
        const publishServer = new ServerSidePublishEngine();
        const send_response_for_request_spy = sinon.spy(publishServer, "_send_response_for_request");

        const subscription = makeSubscription({
            id: 1234,
            publishingInterval: 1000,
            lifeTimeCount: 1000,
            maxKeepAliveCount: 20,
            //
            publishEngine: publishServer,
            globalCounter: { totalMonitoredItemCount: 0 },
            serverCapabilities: { maxMonitoredItems: 10000, maxMonitoredItemsPerSubscription: 1000 }
        });
        publishServer.add_subscription(subscription);
        const monitoredItem = add_mock_monitored_item(subscription);
        try {
            // simulate a client sending a PublishRequest to the server
            // that acknowledge on a wrong sequenceNumber
            publishServer._on_PublishRequest(
                new PublishRequest({
                    subscriptionAcknowledgements: [
                        {
                            subscriptionId: 1234,
                            sequenceNumber: 36 // <<< INVALID SEQUENCE NUMBER
                        }
                    ]
                })
            );
            flushPending();

            // server send a notification to the client
            monitoredItem.simulateMonitoredItemAddingNotification();

            test.clock.tick(subscription.publishingInterval * 1.2);

            subscription.getAvailableSequenceNumbers().should.eql([1]);

            send_response_for_request_spy.callCount.should.equal(1);
            send_response_for_request_spy.getCall(0).args[1].schema.name.should.equal("PublishResponse");
            const response = send_response_for_request_spy.getCall(0).args[1] as PublishResponse;
            response.responseHeader.serviceResult.should.eql(StatusCodes.Good);
            response.results!.should.eql([StatusCodes.BadSequenceNumberUnknown]);
        } finally {
            subscription.terminate();
            subscription.dispose();
            publishServer.shutdown();
            publishServer.dispose();
        }
    });

    it("ZDZ-B     a subscription shall send a keep-alive message at the end of the first publishing interval, if there are no Notifications ready.", () => {
        const publish_server = new ServerSidePublishEngine();

        const send_keep_alive_response_spy = sinon.spy(publish_server, "send_keep_alive_response");
        const send_response_for_request_spy = sinon.spy(publish_server, "_send_response_for_request");

        const subscription = makeSubscription({
            id: 1234,
            publishingInterval: 1000,
            lifeTimeCount: 4,
            maxKeepAliveCount: 20,
            publishEngine: publish_server,
            globalCounter: { totalMonitoredItemCount: 0 },
            serverCapabilities: { maxMonitoredItems: 10000, maxMonitoredItemsPerSubscription: 1000 }
        });
        publish_server.add_subscription(subscription);
        try {
            // make sure we have at least 5 PublishRequest in queue
            publish_server.maxPublishRequestInQueue.should.be.greaterThan(5);
            subscription.maxKeepAliveCount.should.eql(20);
            subscription.state.should.eql(SubscriptionState.CREATING);

            publish_server._on_PublishRequest(new PublishRequest());
            publish_server._on_PublishRequest(new PublishRequest());
            publish_server._on_PublishRequest(new PublishRequest());
            publish_server._on_PublishRequest(new PublishRequest());
            publish_server._on_PublishRequest(new PublishRequest());

            test.clock.tick(subscription.publishingInterval * 1);

            // Immediately  a keep Alive message shall be send
            subscription.state.should.eql(SubscriptionState.KEEPALIVE);
            subscription.publishIntervalCount.should.eql(1);
            send_keep_alive_response_spy.callCount.should.equal(1);
            send_response_for_request_spy.callCount.should.eql(1);

            test.clock.tick(subscription.publishingInterval);
            subscription.state.should.eql(SubscriptionState.KEEPALIVE);

            subscription.publishIntervalCount.should.eql(2);
            send_keep_alive_response_spy.callCount.should.equal(1);
            send_response_for_request_spy.callCount.should.eql(1);

            // after maxKeepAliveCount * publishingCycle a second keep Alive message shall be send
            test.clock.tick(subscription.publishingInterval * 20);

            subscription.state.should.eql(SubscriptionState.KEEPALIVE);
            subscription.publishIntervalCount.should.eql(subscription.maxKeepAliveCount + 2);
            send_keep_alive_response_spy.callCount.should.equal(2);
            send_response_for_request_spy.callCount.should.eql(2);
        } finally {
            subscription.terminate();
            subscription.dispose();
            publish_server.shutdown();
            publish_server.dispose();
        }
    });

    it("ZDZ-C a Normal subscription that receives a notification shall wait for the next publish interval to send a PublishResponse ", () => {
        const publish_server = new ServerSidePublishEngine();

        const send_keep_alive_response_spy = sinon.spy(publish_server, "send_keep_alive_response");
        const send_notification_message_spy = sinon.spy(publish_server, "_send_response");

        const subscription = makeSubscription({
            id: 1234,
            publishingInterval: 1000,
            lifeTimeCount: 4,
            maxKeepAliveCount: 20,
            publishEngine: publish_server,
            maxNotificationsPerPublish: 0, // no limits,
            globalCounter: { totalMonitoredItemCount: 0 },
            serverCapabilities: { maxMonitoredItems: 10000, maxMonitoredItemsPerSubscription: 1000 }
        });
        publish_server.add_subscription(subscription);

        try {
            const monitoredItem = add_mock_monitored_item(subscription);

            monitoredItem.simulateMonitoredItemAddingNotification();

            // make sure we have at least 5 PublishRequest in queue
            publish_server.maxPublishRequestInQueue.should.be.greaterThan(5);
            publish_server._on_PublishRequest(new PublishRequest());
            publish_server._on_PublishRequest(new PublishRequest());
            publish_server._on_PublishRequest(new PublishRequest());
            publish_server._on_PublishRequest(new PublishRequest());
            publish_server._on_PublishRequest(new PublishRequest());

            test.clock.tick(2);
            publish_server.pendingPublishRequestCount.should.eql(4);

            test.clock.tick(subscription.publishingInterval);
            subscription.state.should.eql(SubscriptionState.NORMAL);
            subscription.publishIntervalCount.should.eql(2);

            test.clock.tick(subscription.publishingInterval);
            subscription.publishIntervalCount.should.eql(3);
            subscription.state.should.eql(SubscriptionState.NORMAL);

            send_keep_alive_response_spy.callCount.should.eql(0);
            send_notification_message_spy.callCount.should.eql(1);
        } finally {
            subscription.terminate();
            subscription.dispose();
            publish_server.shutdown();
            publish_server.dispose();
        }
    });

    it("ZDZ-D the subscription state shall be set to LATE, if it cannot process a notification after Publish Interval has been raised, due to a lack of PublishRequest", () => {
        const publish_server = new ServerSidePublishEngine();

        publish_server.maxPublishRequestInQueue.should.be.greaterThan(5);

        const subscription = makeSubscription({
            id: 1234,
            publishingInterval: 1000,
            lifeTimeCount: 60,
            maxKeepAliveCount: 20,
            publishEngine: publish_server,
            globalCounter: { totalMonitoredItemCount: 0 },
            serverCapabilities: { maxMonitoredItems: 10000, maxMonitoredItemsPerSubscription: 1000 }
        });
        publish_server.add_subscription(subscription);
        try {
            const monitoredItem = add_mock_monitored_item(subscription);

            publish_server.pendingPublishRequestCount.should.eql(0, " No PublishRequest in queue");

            test.clock.tick(subscription.publishingInterval);
            subscription.state.should.equal(SubscriptionState.LATE);

            monitoredItem.simulateMonitoredItemAddingNotification();
            test.clock.tick(subscription.publishingInterval * 1.2);

            subscription.state.should.equal(SubscriptionState.LATE);
            publish_server.pendingPublishRequestCount.should.eql(0, " No PublishRequest in queue");
        } finally {
            subscription.terminate();
            subscription.dispose();

            publish_server.shutdown();
            publish_server.dispose();
        }
    });

    it("ZDZ-E a subscription should provide its time to expiration so that publish engine could sort late subscriptions by order of priority", () => {
        const publish_server = new ServerSidePublishEngine();
        const subscription = makeSubscription({
            id: 1234,
            publishingInterval: 1000,
            lifeTimeCount: 60,
            maxKeepAliveCount: 2,
            publishEngine: publish_server,
            globalCounter: { totalMonitoredItemCount: 0 },
            serverCapabilities: { maxMonitoredItems: 10000, maxMonitoredItemsPerSubscription: 1000 }
        });
        publish_server.add_subscription(subscription);
        const monitoredItem = add_mock_monitored_item(subscription);
        try {
            subscription.lifeTimeCount.should.eql(60);
            subscription.timeToExpiration.should.eql(1000 * 60);

            test.clock.tick(subscription.publishingInterval);
            subscription.timeToExpiration.should.eql(1000 * 60);

            test.clock.tick(subscription.publishingInterval);
            subscription.timeToExpiration.should.eql(1000 * 59);

            test.clock.tick(subscription.publishingInterval);
            subscription.timeToExpiration.should.eql(1000 * 58);
            subscription.state.should.eql(SubscriptionState.LATE);
        } finally {
            subscription.terminate();
            subscription.dispose();
            publish_server.shutdown();
            publish_server.dispose();
        }
    });

    // eslint-disable-next-line max-statements
    it("ZDZ-F a publish engine should be able to find out which are the most urgent late subscriptions to serve ", () => {
        const publish_server = new ServerSidePublishEngine();
        publish_server.pendingPublishRequestCount.should.eql(0, " No PublishRequest in queue");

        const subscription1 = makeSubscription({
            id: 1,
            publishingInterval: 1000,
            lifeTimeCount: 60,
            maxKeepAliveCount: 20,
            publishingEnabled: true,
            publishEngine: publish_server,
            globalCounter: { totalMonitoredItemCount: 0 },
            serverCapabilities: { maxMonitoredItems: 10000, maxMonitoredItemsPerSubscription: 1000 }
        });
        subscription1.publishingInterval.should.eql(1000);
        subscription1.lifeTimeCount.should.eql(60);
        subscription1.maxKeepAliveCount.should.eql(20);

        publish_server.add_subscription(subscription1);

        publish_server._on_PublishRequest(new PublishRequest());
        publish_server._on_PublishRequest(new PublishRequest());
        publish_server._on_PublishRequest(new PublishRequest());
        publish_server._on_PublishRequest(new PublishRequest());
        publish_server._on_PublishRequest(new PublishRequest());
        publish_server._on_PublishRequest(new PublishRequest());
        publish_server._on_PublishRequest(new PublishRequest());
        publish_server._on_PublishRequest(new PublishRequest());
        publish_server._on_PublishRequest(new PublishRequest());
        publish_server._on_PublishRequest(new PublishRequest());
        publish_server._on_PublishRequest(new PublishRequest());
        publish_server._on_PublishRequest(new PublishRequest());

        const subscription2 = makeSubscription({
            id: 2,
            publishingInterval: 100,
            lifeTimeCount: 120,
            maxKeepAliveCount: 20,
            publishingEnabled: true,
            publishEngine: publish_server,
            globalCounter: { totalMonitoredItemCount: 0 },
            serverCapabilities: { maxMonitoredItems: 10000, maxMonitoredItemsPerSubscription: 1000 }
        });
        subscription2.publishingInterval.should.eql(100);
        subscription2.lifeTimeCount.should.eql(120);
        subscription2.maxKeepAliveCount.should.eql(20);
        publish_server.add_subscription(subscription2);

        const subscription3 = makeSubscription({
            id: 3,
            publishingInterval: 100,
            lifeTimeCount: 1000,
            maxKeepAliveCount: 20,
            publishingEnabled: true,
            publishEngine: publish_server,
            globalCounter: { totalMonitoredItemCount: 0 },
            serverCapabilities: { maxMonitoredItems: 10000, maxMonitoredItemsPerSubscription: 1000 }
        });

        try {
            subscription3.publishingInterval.should.eql(100); // !! Note that publishingInterval has been clamped in constructor
            subscription3.lifeTimeCount.should.eql(1000);
            subscription3.maxKeepAliveCount.should.eql(20);

            publish_server.add_subscription(subscription3);

            const monitoredItem1 = add_mock_monitored_item(subscription1);
            const monitoredItem2 = add_mock_monitored_item(subscription2);
            const monitoredItem3 = add_mock_monitored_item(subscription3);

            subscription1.lifeTimeCount.should.eql(60);
            subscription2.lifeTimeCount.should.eql(120);
            subscription3.lifeTimeCount.should.eql(1000);

            subscription1.timeToExpiration.should.eql(1000 * 60);
            subscription2.timeToExpiration.should.eql(100 * 120);
            subscription3.timeToExpiration.should.eql(100 * 1000);

            // add some notification we want to process
            monitoredItem1.simulateMonitoredItemAddingNotification();
            monitoredItem2.simulateMonitoredItemAddingNotification();
            monitoredItem3.simulateMonitoredItemAddingNotification();

            // let move in time so that subscriptions starts
            test.clock.tick(
                Math.max(subscription1.publishingInterval, subscription2.publishingInterval, subscription3.publishingInterval)
            );

            subscription1.state.should.eql(SubscriptionState.NORMAL);
            subscription2.state.should.eql(SubscriptionState.NORMAL);
            subscription3.state.should.eql(SubscriptionState.NORMAL);

            publish_server.findLateSubscriptionsSortedByAge().should.eql([]);

            // let move in time so that all subscriptions get late (without expiring)
            test.clock.tick(
                Math.min(subscription1.timeToExpiration, subscription2.timeToExpiration, subscription3.timeToExpiration) - 10
            );

            subscription1.state.should.eql(SubscriptionState.NORMAL);
            subscription2.state.should.eql(SubscriptionState.LATE);
            subscription3.state.should.eql(SubscriptionState.LATE);

            publish_server.findLateSubscriptionsSortedByAge().map(property("id")).should.eql([2, 3]);

            test.clock.tick(1000 * 20);
            subscription1.state.should.eql(SubscriptionState.LATE);
            subscription2.state.should.eql(SubscriptionState.CLOSED);
            subscription3.state.should.eql(SubscriptionState.LATE);

            publish_server.findLateSubscriptionsSortedByAge().map(property("id")).should.eql([1, 3]);
        } finally {
            subscription1.terminate();
            subscription1.dispose();

            subscription2.terminate();
            subscription2.dispose();

            subscription3.terminate();
            subscription3.dispose();

            publish_server.shutdown();
            publish_server.dispose();
        }
    });

    it("ZDZ-G a LATE subscription that receives a notification shall send a PublishResponse immediately, without waiting for next publish interval", () => {
        const publish_server = new ServerSidePublishEngine();

        const subscription = makeSubscription({
            id: 1234,
            publishingInterval: 1000,
            lifeTimeCount: 60,
            maxKeepAliveCount: 20,
            publishEngine: publish_server,
            globalCounter: { totalMonitoredItemCount: 0 },
            serverCapabilities: { maxMonitoredItems: 10000, maxMonitoredItemsPerSubscription: 1000 }
        });
        publish_server.add_subscription(subscription);

        try {
            const monitoredItem = add_mock_monitored_item(subscription);

            publish_server.pendingPublishRequestCount.should.eql(0, " No PublishRequest in queue");

            test.clock.tick(subscription.publishingInterval);
            subscription.state.should.equal(SubscriptionState.LATE);

            monitoredItem.simulateMonitoredItemAddingNotification();
            test.clock.tick(subscription.publishingInterval * 1.2);

            subscription.state.should.equal(SubscriptionState.LATE);
            publish_server.pendingPublishRequestCount.should.eql(0, " No PublishRequest in queue");

            publish_server._on_PublishRequest(new PublishRequest());
            test.clock.tick(0);

            publish_server.pendingPublishRequestCount.should.eql(
                0,
                "starving subscription should have consumed this Request immediately"
            );

            subscription.state.should.equal(SubscriptionState.NORMAL);
        } finally {
            subscription.terminate();
            subscription.dispose();

            publish_server.shutdown();
            publish_server.dispose();
        }
    });

    it("ZDZ-H LifetimeCount, the server shall terminated the subscription if it has not received any PublishRequest after LifeTimeCount cycles", () => {
        const publish_server = new ServerSidePublishEngine();

        // given a subscription
        const subscription = makeSubscription({
            id: 1234,
            publishingInterval: 1000,
            lifeTimeCount: 0,
            maxKeepAliveCount: 4,
            publishEngine: publish_server,
            globalCounter: { totalMonitoredItemCount: 0 },
            serverCapabilities: { maxMonitoredItems: 10000, maxMonitoredItemsPerSubscription: 1000 }
        });
        try {
            subscription.maxKeepAliveCount.should.eql(4);
            subscription.lifeTimeCount.should.eql(12); // should be adjusted

            subscription.state.should.eql(SubscriptionState.CREATING);
            publish_server.add_subscription(subscription);
            const monitoredItem = add_mock_monitored_item(subscription);

            publish_server._on_PublishRequest(new PublishRequest());
            test.clock.tick(subscription.publishingInterval);
            subscription.publishIntervalCount.should.eql(2);
            subscription.state.should.eql(SubscriptionState.NORMAL);

            publish_server._on_PublishRequest(new PublishRequest());
            test.clock.tick(subscription.publishingInterval * subscription.maxKeepAliveCount);
            subscription.publishIntervalCount.should.eql(subscription.maxKeepAliveCount + 2);
            subscription.state.should.eql(SubscriptionState.KEEPALIVE);

            // server send a notification to the client
            monitoredItem.simulateMonitoredItemAddingNotification();
            subscription.state.should.eql(SubscriptionState.KEEPALIVE);

            // server send a notification to the client
            monitoredItem.simulateMonitoredItemAddingNotification();
            subscription.state.should.eql(SubscriptionState.KEEPALIVE);

            test.clock.tick(subscription.publishingInterval);
            subscription.publishIntervalCount.should.eql(7);
            subscription.state.should.eql(SubscriptionState.LATE);

            test.clock.tick(subscription.publishingInterval * subscription.lifeTimeCount + 20);
            subscription.publishIntervalCount.should.eql(subscription.lifeTimeCount + 7);
            subscription.state.should.eql(SubscriptionState.CLOSED);
        } finally {
            subscription.terminate();
            subscription.dispose();

            publish_server.shutdown();
            publish_server.dispose();
        }
    });

    it("ZDZ-I LifeTimeCount, the publish engine shall send a StatusChangeNotification to inform that a subscription has been closed because of lifetime timeout ", () => {
        const publish_server = new ServerSidePublishEngine();

        const subscription = makeSubscription({
            id: 1234,
            publishingInterval: 1000,
            lifeTimeCount: 60,
            maxKeepAliveCount: 20,
            publishEngine: publish_server,
            globalCounter: { totalMonitoredItemCount: 0 },
            serverCapabilities: { maxMonitoredItems: 10000, maxMonitoredItemsPerSubscription: 1000 }
        });
        publish_server.add_subscription(subscription);
        const monitoredItem = add_mock_monitored_item(subscription);

        try {
            subscription.maxKeepAliveCount.should.eql(20);
            subscription.state.should.eql(SubscriptionState.CREATING);

            test.clock.tick(subscription.publishingInterval);
            subscription.state.should.eql(SubscriptionState.LATE);

            test.clock.tick(subscription.publishingInterval * subscription.lifeTimeCount + 20);
            subscription.state.should.eql(SubscriptionState.CLOSED);

            publish_server.pendingClosedSubscriptionCount.should.eql(1);

            const send_response_for_request_spy = sinon.spy(publish_server, "_send_response_for_request");

            // now send a late PublishRequest
            publish_server._on_PublishRequest(new PublishRequest());

            // we expect this publish request to be immediately consumed
            publish_server.pendingPublishRequestCount.should.eql(0);

            send_response_for_request_spy.callCount.should.equal(1);
            send_response_for_request_spy.firstCall.args[1].responseHeader.serviceResult.should.eql(StatusCodes.Good);

            const response = send_response_for_request_spy.firstCall.args[1] as PublishResponse;
            response.subscriptionId.should.eql(1234);
            response.notificationMessage.notificationData!.length.should.eql(1);
            (response.notificationMessage.notificationData![0]! as any).status.should.eql(StatusCodes.BadTimeout);

            subscription.state.should.eql(SubscriptionState.CLOSED);

            publish_server.pendingClosedSubscriptionCount.should.eql(0);
        } finally {
            publish_server.shutdown();
            publish_server.dispose();
        }
    });

    it("ZDZ-J PublishRequest timeout, the publish engine shall return a publish response with serviceResult = BadTimeout when Publish requests have timed out", () => {
        const publish_server = new ServerSidePublishEngine();

        const subscription = makeSubscription({
            id: 1234,
            publishingInterval: 1000,
            lifeTimeCount: 4,
            maxKeepAliveCount: 20,
            publishEngine: publish_server,
            globalCounter: { totalMonitoredItemCount: 0 },
            serverCapabilities: { maxMonitoredItems: 10000, maxMonitoredItemsPerSubscription: 1000 }
        });
        subscription.lifeTimeCount.should.eql(60);
        subscription.maxKeepAliveCount.should.eql(20);
        subscription.publishingInterval.should.eql(1000);

        publish_server.add_subscription(subscription);

        try {
            subscription.maxKeepAliveCount.should.eql(20);
            subscription.lifeTimeCount.should.eql(60);
            subscription.state.should.eql(SubscriptionState.CREATING);
            const send_response_for_request_spy = sinon.spy(publish_server, "_send_response_for_request");

            const timeoutHint = subscription.publishingInterval * (subscription.maxKeepAliveCount + 2);
            timeoutHint.should.eql(1000 * 22);

            publish_server._on_PublishRequest(new PublishRequest({ requestHeader: { timeoutHint } }));
            publish_server._on_PublishRequest(new PublishRequest({ requestHeader: { timeoutHint } }));
            publish_server._on_PublishRequest(new PublishRequest({ requestHeader: { timeoutHint } }));
            publish_server._on_PublishRequest(new PublishRequest({ requestHeader: { timeoutHint } }));
            publish_server._on_PublishRequest(new PublishRequest({ requestHeader: { timeoutHint } }));
            publish_server.pendingPublishRequestCount.should.eql(5);

            test.clock.tick(subscription.publishingInterval);
            publish_server.pendingPublishRequestCount.should.eql(4); // one should be consumed by subscription after 1 publishing interval

            test.clock.tick(subscription.publishingInterval * subscription.maxKeepAliveCount);
            publish_server.pendingPublishRequestCount.should.eql(3); // a second one should have been consumed by subscription afeter maxKeepAliveCount * publishingInterval

            test.clock.tick(subscription.publishingInterval * 2);
            publish_server.pendingPublishRequestCount.should.eql(0); // all remaining publish request should have been consumed by subscription because they timeout
            send_response_for_request_spy.callCount.should.equal(5); // and we should have received a PublishResponse for all of them

            send_response_for_request_spy.firstCall.args[1].responseHeader.serviceResult.should.eql(StatusCodes.Good);
            publish_server._on_PublishRequest(new PublishRequest({ requestHeader: { timeoutHint } }));

            test.clock.tick(subscription.publishingInterval * 3);
            // all remaining 4 publish request must have been detected a timeout now and answered as such.
            send_response_for_request_spy.callCount.should.equal(5);
            publish_server.pendingPublishRequestCount.should.eql(1);
            send_response_for_request_spy.getCall(1).args[1].responseHeader.serviceResult.should.eql(StatusCodes.Good);
            // 
            send_response_for_request_spy.getCall(2).args[1].responseHeader.serviceResult.should.eql(StatusCodes.BadTimeout);
            send_response_for_request_spy.getCall(3).args[1].responseHeader.serviceResult.should.eql(StatusCodes.BadTimeout);
            send_response_for_request_spy.getCall(4).args[1].responseHeader.serviceResult.should.eql(StatusCodes.BadTimeout);
        } finally {
            subscription.terminate();
            subscription.dispose();

            publish_server.shutdown();
            publish_server.dispose();
        }
    });
});
