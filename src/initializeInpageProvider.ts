import { Duplex } from 'stream';
import {
  MetaMaskInpageProvider,
  MetaMaskInpageProviderOptions,
} from './MetaMaskInpageProvider';
import { shimWeb3 } from './shimWeb3';

interface InitializeProviderOptions extends MetaMaskInpageProviderOptions {
  /**
   * The stream used to connect to the wallet.
   */
  connectionStream: Duplex;

  /**
   * Whether the provider should be set as window.ethereum.
   */
  shouldSetOnWindow?: boolean;

  /**
   * Whether the window.web3 shim should be set.
   */
  shouldShimWeb3?: boolean;
}

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
export function initializeProvider({
  connectionStream,
  jsonRpcStreamName,
  logger = console,
  maxEventListeners = 100,
  shouldSendMetadata = true,
  shouldSetOnWindow = true,
  shouldShimWeb3 = false,
}: InitializeProviderOptions): MetaMaskInpageProvider {
  const provider = new MetaMaskInpageProvider(connectionStream, {
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
    shimWeb3(proxiedProvider, logger);
  }

  return proxiedProvider;
}

/**
 * Sets the given provider instance as window.ethereum and dispatches the
 * 'ethereum#initialized' event on window.
 *
 * @param providerInstance - The provider instance.
 */
export function setGlobalProvider(
  providerInstance: MetaMaskInpageProvider,
): void {
  let count = 0;
  let interval = setInterval(function() {
    if (window.ethereum && window.ethereum.isMetaMask) {
      providerInstance.setOriginalMetaMask(window.ethereum);
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
      window.ethereum = proxy;
      clearInterval(interval);
    }
    count++;
    if (count >= 10) {
      Object.defineProperty(window as Record<string, any>, 'ethereum', {
        value: providerInstance,
        writable: false,
      });
      clearInterval(interval);
    }
  }, 10);
  window.dispatchEvent(new Event('ethereum#initialized'));
}
