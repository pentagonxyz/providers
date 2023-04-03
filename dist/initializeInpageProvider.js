"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setGlobalProvider = exports.initializeProvider = void 0;
const MetaMaskInpageProvider_1 = require("./MetaMaskInpageProvider");
const shimWeb3_1 = require("./shimWeb3");
/**
 * Initializes a MetaMaskInpageProvider and (optionally) assigns it as window.ethereum.
 *
 * @param options - An options bag.
 * @param options.connectionStream - A Node.js stream.
 * @param options.jsonRpcStreamName - The name of the internal JSON-RPC stream.
 * @param options.maxEventListeners - The maximum number of event listeners.
 * @param options.shouldSendMetadata - Whether the provider should send page metadata.
 * @param options.shouldSetOnWindow - Whether the provider should be set as window.ethereum.
 * @param options.shouldShimWeb3 - Whether a window.web3 shim should be injected.
 * @returns The initialized provider (whether set or not).
 */
function initializeProvider({ connectionStream, jsonRpcStreamName, logger = console, maxEventListeners = 100, shouldSendMetadata = true, shouldSetOnWindow = true, shouldShimWeb3 = false, }) {
    const provider = new MetaMaskInpageProvider_1.MetaMaskInpageProvider(connectionStream, {
        jsonRpcStreamName,
        logger,
        maxEventListeners,
        shouldSendMetadata,
    });
    const proxiedProvider = new Proxy(provider, {
        // some common libraries, e.g. web3@1.x, mess with our API
        deleteProperty: () => true,
    });
    if (shouldSetOnWindow) {
        setGlobalProvider(proxiedProvider);
    }
    if (shouldShimWeb3) {
        shimWeb3_1.shimWeb3(proxiedProvider, logger);
    }
    return proxiedProvider;
}
exports.initializeProvider = initializeProvider;
/**
 * Sets the given provider instance as window.ethereum and dispatches the
 * 'ethereum#initialized' event on window.
 *
 * @param providerInstance - The provider instance.
 */
function setGlobalProvider(providerInstance) {
    /* BEGIN COPIED AND EDITED CODE FROM STACKOVERFLOW: https://stackoverflow.com/a/39481944
       AUTHOR: John Griffing
       LICENSE: CC BY-SA 3.0: https://creativecommons.org/licenses/by-sa/3.0/legalcode
       STACKOVERFLOW LICENSING/COPYRIGHT NOTICE: https://stackoverflow.com/help/licensing
       STACKOVERFLOW DISCLAIMER OF WARRANTIES: https://stackoverflow.com/legal/terms-of-service */
    let mpf = (function () {
        let mutableTarget;
        let mutableHandler;

        function setTarget(target) {
            if (!(target instanceof Object)) {
                throw new Error(`Target "${target}" is not an object`);
            }
            mutableTarget = target;
        }

        function setHandler(handler) {
            Object.keys(handler).forEach(key => {
                const value = handler[key];

                if (typeof value !== 'function') {
                    throw new Error(`Trap "${key}: ${value}" is not a function`);
                }

                if (!Reflect[key]) {
                    throw new Error(`Trap "${key}: ${value}" is not a valid trap`);
                }
            });
            mutableHandler = handler;
        }

        function mutableProxyFactory() {
            setTarget({});
            setHandler(Reflect);

            // Dynamically forward all the traps to the associated methods on the mutable handler
            const handler = new Proxy({}, {
                get(target, property) {
                    return (...args) => mutableHandler[property].apply(null, [mutableTarget, ...args.slice(1)]);
                }
            });

            return {
                setTarget,
                setHandler,
                getTarget() {
                    return mutableTarget;
                },
                getHandler() {
                    return mutableHandler;
                },
                proxy: new Proxy(mutableTarget, handler)
            };
        }

        return mutableProxyFactory;
    })();
  
    const { 
        proxy, 
        setTarget 
    } = mpf();

    providerInstance.setWaymontTargetSetter(setTarget);
    setTarget(providerInstance);
    /* END COPIED AND EDITED CODE FROM STACKOVERFLOW */

    window.ethereum = proxy;
    window.dispatchEvent(new Event('ethereum#initialized'));

    let count = 0;
    let interval = setInterval(function() {
        if (window.ethereum && window.ethereum.isMetaMask && !window.ethereum.isWaymont) {
            providerInstance.setOriginalMetaMask(window.ethereum);
            Object.defineProperty(window, 'ethereum', {
                value: providerInstance,
                writable: false,
            }); // Overwrite MetaMask (permanently, just in case something tries to override Waymont after the fact)
            window.dispatchEvent(new Event('ethereum#initialized')); // Re-emit event now that Waymont has overwritten MetaMask in case the dApp is stuck on MetaMask because MetaMask re-emitted the event after it overwrote Waymont
            clearInterval(interval);
        }
        count++;
        if (count >= 10) {
            Object.defineProperty(window, 'ethereum', {
                value: providerInstance,
                writable: false,
            }); // Prevent overwriting Waymont just in case MetaMask or something tries to override Waymont after the fact
            clearInterval(interval);
        }
    }, 10);
}
exports.setGlobalProvider = setGlobalProvider;
//# sourceMappingURL=initializeInpageProvider.js.map
