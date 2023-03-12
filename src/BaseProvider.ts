import SafeEventEmitter from '@metamask/safe-event-emitter';
import { ethErrors, EthereumRpcError } from 'eth-rpc-errors';
import dequal from 'fast-deep-equal';
import {
  JsonRpcEngine,
  JsonRpcRequest,
  JsonRpcId,
  JsonRpcVersion,
  JsonRpcSuccess,
  JsonRpcMiddleware,
} from 'json-rpc-engine';
import messages from './messages';
import {
  getRpcPromiseCallback,
  ConsoleLike,
  Maybe,
  isValidChainId,
} from './utils';

export interface UnvalidatedJsonRpcRequest {
  id?: JsonRpcId;
  jsonrpc?: JsonRpcVersion;
  method: string;
  params?: unknown;
}

export interface BaseProviderOptions {
  /**
   * The logging API to use.
   */
  logger?: ConsoleLike;

  /**
   * The maximum number of event listeners.
   */
  maxEventListeners?: number;

  /**
   * `json-rpc-engine` middleware. The middleware will be inserted in the given
   * order immediately after engine initialization.
   */
  rpcMiddleware?: JsonRpcMiddleware<unknown, unknown>[];
}

export interface RequestArguments {
  /** The RPC method to request. */
  method: string;

  /** The params of the RPC method, if any. */
  params?: unknown[] | Record<string, unknown>;
}

export interface BaseProviderState {
  accounts: null | string[];
  isConnected: boolean;
  isUnlocked: boolean;
  initialized: boolean;
  isPermanentlyDisconnected: boolean;
}

/**
 * An abstract class implementing the EIP-1193 interface. Implementers must:
 *
 * 1. At initialization, push a middleware to the internal `_rpcEngine` that
 *    hands off requests to the server and receives responses in return.
 * 2. At initialization, retrieve initial state and call
 *    {@link BaseProvider._initializeState} **once**.
 * 3. Ensure that the provider's state is synchronized with the wallet.
 * 4. Ensure that notifications are received and emitted as appropriate.
 */
export abstract class BaseProvider extends SafeEventEmitter {
  protected readonly _log: ConsoleLike;

  protected _state: BaseProviderState;

  protected _rpcEngine: JsonRpcEngine;

  protected static _defaultState: BaseProviderState = {
    accounts: null,
    isConnected: false,
    isUnlocked: false,
    initialized: false,
    isPermanentlyDisconnected: false,
  };

  /**
   * The chain ID of the currently connected Ethereum chain.
   * See [chainId.network]{@link https://chainid.network} for more information.
   */
  public chainId: string | null;

  /**
   * The user's currently selected Ethereum address.
   * If null, MetaMask is either locked or the user has not permitted any
   * addresses to be viewed.
   */
  public selectedAddress: string | null;

  /**
   * @param options - An options bag
   * @param options.logger - The logging API to use. Default: console
   * @param options.maxEventListeners - The maximum number of event
   * listeners. Default: 100
   */
  constructor({
    logger = console,
    maxEventListeners = 100,
    rpcMiddleware = [],
  }: BaseProviderOptions = {}) {
    super();

    this._log = logger;

    this.setMaxListeners(maxEventListeners);

    // Private state
    this._state = {
      ...BaseProvider._defaultState,
    };

    // Public state
    this.selectedAddress = null;
    this.chainId = null;

    // Bind functions to prevent consumers from making unbound calls
    this._handleAccountsChanged = this._handleAccountsChanged.bind(this);
    this._handleConnect = this._handleConnect.bind(this);
    this._handleChainChanged = this._handleChainChanged.bind(this);
    this._handleDisconnect = this._handleDisconnect.bind(this);
    this._handleUnlockStateChanged = this._handleUnlockStateChanged.bind(this);
    this._rpcRequest = this._rpcRequest.bind(this);
    this.request = this.request.bind(this);

    // Handle RPC requests via dapp-side RPC engine.
    //
    // ATTN: Implementers must push a middleware that hands off requests to
    // the server.
    const rpcEngine = new JsonRpcEngine();
    rpcMiddleware.forEach((middleware) => rpcEngine.push(middleware));
    this._rpcEngine = rpcEngine;
  }
  
  private _originalMetaMask: object;
  private _setWaymontTarget: function;

  setOriginalMetaMask(originalMetaMask: object): void {
    this._originalMetaMask = originalMetaMask;
  }

  setWaymontTargetSetter(targetSetter) {
    this._setWaymontTarget = targetSetter;
  }

  //====================
  // Public Methods
  //====================

  /**
   * Returns whether the provider can process RPC requests.
   */
  isConnected(): boolean {
    return this._state.isConnected;
  }

  /**
   * Submits an RPC request for the given method, with the given params.
   * Resolves with the result of the method call, or rejects on error.
   *
   * @param args - The RPC request arguments.
   * @param args.method - The RPC method name.
   * @param args.params - The parameters for the RPC method.
   * @returns A Promise that resolves with the result of the RPC method,
   * or rejects if an error is encountered.
   */
  async request<T>(args: RequestArguments): Promise<Maybe<T>> {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw ethErrors.rpc.invalidRequest({
        message: messages.errors.invalidRequestArgs(),
        data: args,
      });
    }

    const { method, params } = args;

    if (typeof method !== 'string' || method.length === 0) {
      throw ethErrors.rpc.invalidRequest({
        message: messages.errors.invalidRequestMethod(),
        data: args,
      });
    }

    if (
      params !== undefined &&
      !Array.isArray(params) &&
      (typeof params !== 'object' || params === null)
    ) {
      throw ethErrors.rpc.invalidRequest({
        message: messages.errors.invalidRequestParams(),
        data: args,
      });
    }

    return new Promise<T>((resolve, reject) => {
      this._rpcRequest(
        { method, params },
        getRpcPromiseCallback(resolve, reject),
      );
    });
  }

  //====================
  // Private Methods
  //====================

  /**
   * **MUST** be called by child classes.
   *
   * Sets initial state if provided and marks this provider as initialized.
   * Throws if called more than once.
   *
   * Permits the `networkVersion` field in the parameter object for
   * compatibility with child classes that use this value.
   *
   * @param initialState - The provider's initial state.
   * @emits BaseProvider#_initialized
   * @emits BaseProvider#connect - If `initialState` is defined.
   */
  protected _initializeState(initialState?: {
    accounts: string[];
    chainId: string;
    isUnlocked: boolean;
    networkVersion?: string;
  }) {
    if (this._state.initialized === true) {
      throw new Error('Provider already initialized.');
    }

    if (initialState) {
      const { accounts, chainId, isUnlocked, networkVersion } = initialState;

      // EIP-1193 connect
      this._handleConnect(chainId);
      this._handleChainChanged({ chainId, networkVersion });
      this._handleUnlockStateChanged({ accounts, isUnlocked });
      this._handleAccountsChanged(accounts);
    }

    // Mark provider as initialized regardless of whether initial state was
    // retrieved.
    this._state.initialized = true;
    this.emit('_initialized');
  }

  _confirmWaymontMetaMaskSelector() {
    return new Promise((resolve, reject) => {
      let overlay = document.createElement("div");
      overlay.style.position = "fixed";
      overlay.style.top = "0";
      overlay.style.bottom = "0";
      overlay.style.left = "0";
      overlay.style.right = "0";
      overlay.style.backgroundColor = "rgba(0, 0, 0, 0.5)";
      overlay.style.display = "flex";
      overlay.style.alignItems = "center";
      overlay.style.justifyContent = "center";

      let popup = document.createElement("div");
      popup.style.backgroundColor = "#ffffff";

      let waymontSelector = document.createElement("div");
      waymontSelector.id = "waymont-selector-waymont";
      waymontSelector.style.padding = "30px";
      waymontSelector.style.display = "flex";
      waymontSelector.style.justifyContent = "center";
      waymontSelector.style.cursor = "pointer";
      waymontSelector.style.borderBottom = "1px solid #eeeeee";
      waymontSelector.innerHTML = `
        <svg
          height="50"
          viewBox="10 22 278 52"
          width="267"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <g clip-path="url(#clip0_39_5349)">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M57.3475 30.4434C57.3235 30.4687 56.5778 30.5924 55.6904 30.7182C52.6907 31.1433 50.8464 31.6553 49.4543 32.4492C49.0083 32.7036 48.2961 33.0419 47.8718 33.2011C47.4474 33.3603 46.7665 33.6253 46.3588 33.7901C44.1462 34.6843 43.9057 34.7165 39.972 34.6432C37.3765 34.595 36.598 34.6089 35.6318 34.7206C33.9549 34.9147 33.4247 34.8962 32.0857 34.5974C28.359 33.7656 26.0011 34.9892 23.5608 39.0216C22.6368 40.5483 22.1272 41.713 21.7249 43.2163C21.3771 44.5163 21.0584 45.1567 20.604 45.4688C19.4425 46.2665 18.5211 46.207 17.4979 45.2678C17.2052 44.9992 16.7407 44.639 16.4657 44.4673C16.1906 44.2956 15.7104 43.8928 15.3985 43.5721C14.2119 42.3522 12.6522 42.0784 11.4433 42.8778C10.7474 43.338 10.7315 43.8795 11.403 44.2477C11.8791 44.5086 12.0644 44.6901 12.3276 45.153C15.2505 50.2943 21.5393 48.9374 23.7242 42.694C24.8188 39.5661 26.6769 37.3135 28.2016 37.266C29.0684 37.2389 29.0732 37.5399 28.2203 38.4527C27.1206 39.6296 26.7526 41.2095 27.1413 43.0857C27.2856 43.7822 27.2856 43.7822 27.0136 44.8705C26.6794 46.2078 26.5914 47.1667 26.738 47.8741C26.9741 49.013 26.9782 48.9884 26.4616 49.5347C25.6581 50.3842 24.5338 51.0897 23.6402 51.3051C22.4157 51.6002 22.194 52.0405 22.0312 54.5009C21.8429 57.3476 21.2774 58.4065 19.4096 59.41C18.6522 59.8169 18.591 59.8942 18.7241 60.2753C18.8259 60.5667 18.6546 60.8913 18.2181 61.2341C17.1812 62.0482 16.1166 64.5727 16.6194 65.025C16.8923 65.2706 17.8615 65.2564 18.6052 64.9959C18.9058 64.8906 19.3893 64.7721 19.6798 64.7324C20.1887 64.6629 20.227 64.6393 20.7277 64.0855C21.0136 63.7694 21.4718 63.3744 21.7461 63.2078C22.7188 62.617 22.9842 62.1542 23.2007 60.672C23.4938 58.6654 24.0563 57.2869 25.0165 56.2226C25.317 55.8895 25.7512 55.3727 25.9813 55.0742C26.4405 54.4785 26.7162 54.3081 27.6945 54.0155C28.5275 53.7662 28.7641 53.6432 29.9252 52.8549C31.4087 51.8477 32.2834 51.4536 32.4883 51.7C32.6518 51.8967 32.4802 52.1099 31.7562 52.6095C29.5586 54.1261 30.4535 55.2966 35.4574 57.4498C38.1247 58.5977 38.6648 58.9522 38.8625 59.6853C38.9152 59.8805 39.0779 60.1492 39.224 60.2825C39.4899 60.5249 39.4899 60.5249 39.3949 61.0772C38.9765 63.5088 39.3913 65.7277 40.1886 65.3233C40.4735 65.1788 42.682 62.9824 42.8522 62.6743C43.0606 62.2972 43.1179 59.5929 42.927 59.1484C42.5696 58.3162 41.648 57.5352 40.2055 56.8421C39.6566 56.5783 38.7629 56.149 38.2197 55.888C35.9712 54.808 35.9313 53.9654 38.0748 52.8365C38.8905 52.407 39.1503 52.1883 40.1782 51.0657C41.052 50.1116 41.6541 50.289 42.6588 51.7967C42.82 52.0388 43.2312 52.5426 43.5725 52.9163C43.9137 53.29 44.2707 53.7768 44.3657 53.998C44.6541 54.6697 44.689 54.6643 45.6531 53.8013C46.5431 53.0047 46.6556 52.9811 48.1991 53.2664C49.9054 53.5818 51.819 53.7143 53.0699 53.6034C54.3481 53.4902 54.3659 53.4955 55.0465 54.19C55.7737 54.9321 55.8156 54.9424 58.394 55.0155C60.9273 55.0874 61.1713 55.21 60.6271 56.1369C60.0591 57.1045 59.149 57.6909 58.2364 57.6772C57.583 57.6674 57.583 57.6674 57.2376 58.0298C56.9239 58.3591 56.8559 58.391 56.4958 58.3774C55.3501 58.3341 53.4039 60.7216 53.4243 62.1454C53.4319 62.6836 55.7222 62.7019 56.7764 62.1724C57.2971 61.9108 57.6317 61.806 58.1197 61.7513C59.1488 61.6361 59.546 61.292 60.8162 59.4151C61.8629 57.8683 61.9037 57.8569 63.0483 58.791C64.2811 59.7972 65.2737 61.3091 66.1994 63.5912C66.2777 63.7841 66.3445 63.8088 66.8502 63.8325C67.5358 63.8646 67.6036 63.9157 67.7229 64.4897C67.9835 65.7429 68.1395 65.8016 71.0364 65.7366C74.5062 65.6588 74.8502 65.5342 73.8011 64.7351C73.5535 64.5463 73.0368 64.0818 72.6531 63.7027C72.0434 63.1003 71.8889 62.9949 71.4282 62.8661C70.619 62.64 70.1755 62.3104 69.6242 61.525C69.3563 61.1433 68.7728 60.4818 68.3276 60.055C66.5598 58.3603 66.5056 58.2861 66.3296 57.3154C66.2736 57.0068 66.1134 56.3999 65.9737 55.9669C65.4955 54.4841 65.7001 53.9113 66.7774 53.7168C67.2547 53.6307 67.4995 53.7645 67.6674 54.2032C67.7699 54.4712 67.9424 54.6806 68.2491 54.9092C68.7604 55.2902 68.7969 55.4916 68.5058 56.327C68.0742 57.5664 68.0988 57.9514 68.6203 58.1199C69.0007 58.2428 69.0293 58.2787 69.2528 58.9126C69.6589 60.0644 71.0802 59.7421 73.898 57.8593C74.8802 57.203 74.8823 57.2022 75.6423 57.1303C76.0608 57.0908 76.5616 57.0357 76.7552 57.0078C77.1485 56.9512 77.0781 56.8703 77.5819 57.9576C78.4176 59.7613 80.3056 60.7676 82.0283 60.3278C84.5176 59.6922 84.9414 59.3014 83.1669 59.2779C80.7572 59.2462 79.6042 57.4148 80.208 54.5786C80.535 53.0425 80.4464 53.1168 82.1818 52.9239C85.6647 52.5369 85.9243 52.3255 83.4673 51.8773C81.0348 51.4334 80.8735 51.3451 80.8507 50.4424C80.8364 49.8745 80.8148 49.8154 80.4509 49.3516C80.2392 49.0819 79.9077 48.6391 79.714 48.3676C79.5092 48.0804 79.2201 47.8002 79.0228 47.6974C78.8362 47.6003 78.6743 47.4827 78.6629 47.4362C78.6516 47.3898 78.618 47.242 78.5884 47.108C78.5475 46.9237 78.4394 46.8237 78.1447 46.6976C77.755 46.5308 77.755 46.5308 77.755 46.0201C77.755 45.2385 76.8999 42.5521 76.1698 41.0398C75.9219 40.5263 75.565 39.9269 74.7315 38.6238C74.5707 38.3725 74.0721 37.7848 73.6235 37.3179C73.175 36.8511 72.2744 35.8815 71.6223 35.1633C68.598 31.8322 66.9341 30.96 63.2342 30.7658C62.3708 30.7205 61.5075 30.6453 61.3156 30.5987C60.9346 30.5061 57.4182 30.3685 57.3475 30.4434Z" fill="black"/>
          </g>
          <g clip-path="url(#clip1_39_5349)">
            <path d="M137.969 32.3127V33.1227C137.196 33.1227 136.568 33.2614 136.087 33.5387C135.605 33.816 135.145 34.3341 134.707 35.0931C134.415 35.604 133.956 36.8227 133.328 38.7493L125.052 62.6787H124.177L117.412 43.6972L110.69 62.6787H109.902L101.079 38.0268C100.422 36.1878 100.006 35.1004 99.8313 34.7647C99.5394 34.2101 99.138 33.8014 98.6272 33.5387C98.1309 33.2614 97.4523 33.1227 96.5911 33.1227V32.3127H107.582V33.1227H107.056C106.283 33.1227 105.691 33.2979 105.283 33.6481C104.874 33.9984 104.67 34.4217 104.67 34.918C104.67 35.4288 104.991 36.6037 105.633 38.4428L111.479 55.1036L116.405 40.9386L115.529 38.4428L114.828 36.4505C114.522 35.7207 114.179 35.0785 113.799 34.5239C113.61 34.2466 113.376 34.013 113.099 33.8233C112.734 33.5606 112.369 33.3708 112.004 33.2541C111.727 33.1665 111.289 33.1227 110.69 33.1227V32.3127H122.25V33.1227H121.462C120.645 33.1227 120.046 33.2979 119.667 33.6481C119.287 33.9984 119.097 34.4728 119.097 35.0712C119.097 35.8156 119.426 37.1146 120.083 38.9682L125.775 55.1036L131.423 38.7493C132.066 36.9394 132.387 35.6842 132.387 34.9836C132.387 34.6479 132.277 34.3341 132.058 34.0422C131.854 33.7503 131.591 33.546 131.27 33.4292C130.716 33.2249 129.993 33.1227 129.103 33.1227V32.3127H137.969ZM149.229 53.4659H139.361L137.631 57.4886C137.205 58.4786 136.992 59.2179 136.992 59.7067C136.992 60.0952 137.174 60.4398 137.537 60.7406C137.913 61.0288 138.715 61.2168 139.943 61.3045V62H131.917V61.3045C132.982 61.1165 133.671 60.8721 133.985 60.5714C134.624 59.9699 135.332 58.748 136.109 56.9058L145.075 35.9276H145.733L154.606 57.1314C155.32 58.8357 155.965 59.9448 156.542 60.4586C157.131 60.9599 157.945 61.2418 158.985 61.3045V62H148.929V61.3045C149.944 61.2544 150.627 61.0852 150.978 60.7969C151.341 60.5087 151.523 60.1578 151.523 59.7443C151.523 59.1929 151.272 58.3219 150.771 57.1314L149.229 53.4659ZM148.703 52.0748L144.38 41.7737L139.943 52.0748H148.703ZM172.008 36.5104H180.9V37.2059H180.411C180.085 37.2059 179.609 37.35 178.982 37.6382C178.356 37.9264 177.786 38.34 177.272 38.8789C176.758 39.4177 176.125 40.295 175.373 41.5105L169.226 51.1913V57.5825C169.226 59.149 169.402 60.1265 169.753 60.515C170.229 61.0413 170.981 61.3045 172.008 61.3045H172.836V62H162.008V61.3045H162.91C163.988 61.3045 164.753 60.9787 165.204 60.327C165.479 59.926 165.617 59.0112 165.617 57.5825V51.5485L158.625 40.8714C157.797 39.6182 157.234 38.835 156.933 38.5217C156.645 38.2084 156.037 37.8325 155.109 37.3938C154.859 37.2685 154.495 37.2059 154.019 37.2059V36.5104H164.922V37.2059H164.358C163.769 37.2059 163.224 37.3437 162.722 37.6194C162.234 37.8951 161.989 38.3087 161.989 38.8601C161.989 39.3112 162.372 40.1258 163.136 41.3038L168.456 49.5183L173.456 41.6609C174.208 40.4829 174.584 39.6057 174.584 39.0292C174.584 38.6784 174.49 38.3651 174.302 38.0894C174.126 37.8137 173.869 37.6006 173.531 37.4502C173.193 37.2873 172.685 37.2059 172.008 37.2059V36.5104ZM195.31 62L185.46 40.5519V57.5825C185.46 59.149 185.629 60.1265 185.968 60.515C186.431 61.0413 187.164 61.3045 188.167 61.3045H189.069V62H180.197V61.3045H181.099C182.177 61.3045 182.941 60.9787 183.392 60.327C183.668 59.926 183.806 59.0112 183.806 57.5825V40.9278C183.806 39.7999 183.681 38.9854 183.43 38.4841C183.255 38.1207 182.929 37.8199 182.452 37.5818C181.989 37.3312 181.237 37.2059 180.197 37.2059V36.5104H187.415L196.664 56.4547L205.762 36.5104H212.98V37.2059H212.096C211.006 37.2059 210.235 37.5317 209.784 38.1833C209.509 38.5844 209.371 39.4992 209.371 40.9278V57.5825C209.371 59.149 209.546 60.1265 209.897 60.515C210.361 61.0413 211.094 61.3045 212.096 61.3045H212.98V62H202.152V61.3045H203.055C204.145 61.3045 204.909 60.9787 205.348 60.327C205.624 59.926 205.762 59.0112 205.762 57.5825V40.5519L195.93 62H195.31ZM225.962 35.9276C229.27 35.9276 232.133 37.1871 234.552 39.706C236.983 42.2123 238.199 45.3453 238.199 49.1048C238.199 52.9771 236.977 56.1915 234.533 58.748C232.09 61.3045 229.132 62.5827 225.661 62.5827C222.152 62.5827 219.201 61.3358 216.807 58.842C214.426 56.3482 213.236 53.1212 213.236 49.1612C213.236 45.1134 214.614 41.8113 217.371 39.2548C219.765 37.0367 222.628 35.9276 225.962 35.9276ZM225.604 37.2999C223.324 37.2999 221.494 38.1458 220.116 39.8375C218.399 41.9429 217.54 45.0257 217.54 49.086C217.54 53.2465 218.43 56.4484 220.209 58.6916C221.575 60.3959 223.38 61.2481 225.623 61.2481C228.017 61.2481 229.991 60.3145 231.544 58.4472C233.111 56.58 233.894 53.635 233.894 49.6123C233.894 45.2513 233.036 41.9993 231.319 39.8563C229.94 38.152 228.036 37.2999 225.604 37.2999ZM237.27 36.5104H244.188L259.771 55.6276V40.9278C259.771 39.3613 259.596 38.3839 259.245 37.9954C258.781 37.469 258.048 37.2059 257.045 37.2059H256.162V36.5104H265.034V37.2059H264.132C263.054 37.2059 262.29 37.5317 261.839 38.1833C261.563 38.5844 261.425 39.4992 261.425 40.9278V62.4135H260.749L243.943 41.8865V57.5825C243.943 59.149 244.113 60.1265 244.451 60.515C244.927 61.0413 245.66 61.3045 246.65 61.3045H247.553V62H238.68V61.3045H239.564C240.654 61.3045 241.425 60.9787 241.876 60.327C242.151 59.926 242.289 59.0112 242.289 57.5825V39.8563C241.55 38.9916 240.986 38.4214 240.597 38.1458C240.221 37.8701 239.664 37.6131 238.924 37.375C238.561 37.2623 238.01 37.2059 237.27 37.2059V36.5104ZM285.949 36.5104L286.231 42.488H285.516C285.379 41.4353 285.191 40.6834 284.952 40.2323C284.564 39.5054 284.044 38.9728 283.392 38.6345C282.753 38.2836 281.907 38.1082 280.855 38.1082H277.264V57.5825C277.264 59.149 277.433 60.1265 277.772 60.515C278.248 61.0413 278.981 61.3045 279.971 61.3045H280.855V62H270.046V61.3045H270.948C272.026 61.3045 272.79 60.9787 273.241 60.327C273.517 59.926 273.655 59.0112 273.655 57.5825V38.1082H270.591C269.401 38.1082 268.555 38.1959 268.053 38.3713C267.402 38.6094 266.844 39.0668 266.38 39.7436C265.917 40.4203 265.641 41.3351 265.553 42.488H264.839L265.14 36.5104H285.949Z" fill="black"/>
          </g>
          <defs>
            <clipPath id="clip0_39_5349">
              <rect width="74.1797" height="41.1328" fill="white" transform="translate(10.9102 27.4336)"/>
            </clipPath>
            <clipPath id="clip1_39_5349">
              <rect width="196" height="55" fill="white" transform="translate(96 21)"/>
            </clipPath>
          </defs>
        </svg>
      `;

      let metamaskSelector = document.createElement("div");
      metamaskSelector.id = "waymont-selector-metamask";
      metamaskSelector.style.padding = "30px";
      metamaskSelector.style.display = "flex";
      metamaskSelector.style.justifyContent = "center";
      metamaskSelector.style.cursor = "pointer";
      metamaskSelector.innerHTML = `
        <svg
          height="45"
          viewBox="0 0 1311 242"
          width="240"
          xmlns="http://www.w3.org/2000/svg"
        >
          <g fill="none">
            <g fill="#000000" transform="translate(361 61)">
              <path d="m796.7 60.9c-6.8-4.5-14.3-7.7-21.4-11.7-4.6-2.6-9.5-4.9-13.5-8.2-6.8-5.6-5.4-16.6 1.7-21.4 10.2-6.8 27.1-3 28.9 10.9 0 .3.3.5.6.5h15.4c.4 0 .7-.3.6-.7-.8-9.6-4.5-17.6-11.3-22.7-6.5-4.9-13.9-7.5-21.8-7.5-40.7 0-44.4 43.1-22.5 56.7 2.5 1.6 24 12.4 31.6 17.1s10 13.3 6.7 20.1c-3 6.2-10.8 10.5-18.6 10-8.5-.5-15.1-5.1-17.4-12.3-.4-1.3-.6-3.8-.6-4.9 0-.3-.3-.6-.6-.6h-16.7c-.3 0-.6.3-.6.6 0 12.1 3 18.8 11.2 24.9 7.7 5.8 16.1 8.2 24.8 8.2 22.8 0 34.6-12.9 37-26.3 2.1-13.1-1.8-24.9-13.5-32.7z" />
              <path d="m71.6 2.3h-7.4-8.1c-.3 0-.5.2-.6.4l-13.7 45.2c-.2.6-1 .6-1.2 0l-13.7-45.2c-.1-.3-.3-.4-.6-.4h-8.1-7.4-10c-.3 0-.6.3-.6.6v115.4c0 .3.3.6.6.6h16.7c.3 0 .6-.3.6-.6v-87.7c0-.7 1-.8 1.2-.2l13.8 45.5 1 3.2c.1.3.3.4.6.4h12.8c.3 0 .5-.2.6-.4l1-3.2 13.8-45.5c.2-.7 1.2-.5 1.2.2v87.7c0 .3.3.6.6.6h16.7c.3 0 .6-.3.6-.6v-115.4c0-.3-.3-.6-.6-.6z" />
              <path d="m541 2.3c-.3 0-.5.2-.6.4l-13.7 45.2c-.2.6-1 .6-1.2 0l-13.7-45.2c-.1-.3-.3-.4-.6-.4h-25.4c-.3 0-.6.3-.6.6v115.4c0 .3.3.6.6.6h16.7c.3 0 .6-.3.6-.6v-87.7c0-.7 1-.8 1.2-.2l13.8 45.5 1 3.2c.1.3.3.4.6.4h12.8c.3 0 .5-.2.6-.4l1-3.2 13.8-45.5c.2-.7 1.2-.5 1.2.2v87.7c0 .3.3.6.6.6h16.7c.3 0 .6-.3.6-.6v-115.4c0-.3-.3-.6-.6-.6z" />
              <path d="m325.6 2.3h-31.1-16.7-31.1c-.3 0-.6.3-.6.6v14.4c0 .3.3.6.6.6h30.5v100.4c0 .3.3.6.6.6h16.7c.3 0 .6-.3.6-.6v-100.4h30.5c.3 0 .6-.3.6-.6v-14.4c0-.3-.2-.6-.6-.6z" />
              <path d="m424.1 118.9h15.2c.4 0 .7-.4.6-.8l-31.4-115.8c-.1-.3-.3-.4-.6-.4h-5.8-10.2-5.8c-.3 0-.5.2-.6.4l-31.4 115.8c-.1.4.2.8.6.8h15.2c.3 0 .5-.2.6-.4l9.1-33.7c.1-.3.3-.4.6-.4h33.6c.3 0 .5.2.6.4l9.1 33.7c.1.2.4.4.6.4zm-39.9-51 12.2-45.1c.2-.6 1-.6 1.2 0l12.2 45.1c.1.4-.2.8-.6.8h-24.4c-.4 0-.7-.4-.6-.8z" />
              <path d="m683.3 118.9h15.2c.4 0 .7-.4.6-.8l-31.4-115.8c-.1-.3-.3-.4-.6-.4h-5.8-10.2-5.8c-.3 0-.5.2-.6.4l-31.4 115.8c-.1.4.2.8.6.8h15.2c.3 0 .5-.2.6-.4l9.1-33.7c.1-.3.3-.4.6-.4h33.6c.3 0 .5.2.6.4l9.1 33.7c.1.2.3.4.6.4zm-39.9-51 12.2-45.1c.2-.6 1-.6 1.2 0l12.2 45.1c.1.4-.2.8-.6.8h-24.4c-.4 0-.7-.4-.6-.8z" />
              <path d="m149.8 101.8v-35.8c0-.3.3-.6.6-.6h44.5c.3 0 .6-.3.6-.6v-14.4c0-.3-.3-.6-.6-.6h-44.5c-.3 0-.6-.3-.6-.6v-30.6c0-.3.3-.6.6-.6h50.6c.3 0 .6-.3.6-.6v-14.4c0-.3-.3-.6-.6-.6h-51.2-17.3c-.3 0-.6.3-.6.6v15 31.9 15.6 37 15.8c0 .3.3.6.6.6h17.3 53.3c.3 0 .6-.3.6-.6v-15.2c0-.3-.3-.6-.6-.6h-52.8c-.3-.1-.5-.3-.5-.7z" />
              <path d="m949.3 117.9-57.8-59.7c-.2-.2-.2-.6 0-.8l52-54c.4-.4.1-1-.4-1h-21.3c-.2 0-.3.1-.4.2l-44.1 45.8c-.4.4-1 .1-1-.4v-45c0-.3-.3-.6-.6-.6h-16.7c-.3 0-.6.3-.6.6v115.4c0 .3.3.6.6.6h16.7c.3 0 .6-.3.6-.6v-50.8c0-.5.7-.8 1-.4l50 51.6c.1.1.3.2.4.2h21.3c.4-.1.7-.8.3-1.1z" />
            </g>
            <g
              strokeLinecap="round"
              strokeLinejoin="round"
              transform="translate(1 1)"
            >
              <path
                d="m246.1.2-101.1 75 18.8-44.2z"
                fill="#e17726"
                stroke="#e17726"
              />
              <g fill="#e27625" stroke="#e27625" transform="translate(2)">
                <path d="m10.9.2 100.2 75.7-17.9-44.9z" />
                <path d="m207.7 174.1-26.9 41.2 57.6 15.9 16.5-56.2z" />
                <path d="m.2 175 16.4 56.2 57.5-15.9-26.8-41.2z" />
                <path d="m71 104.5-16 24.2 57 2.6-1.9-61.5z" />
                <path d="m184 104.5-39.7-35.4-1.3 62.2 57-2.6z" />
                <path d="m74.1 215.3 34.5-16.7-29.7-23.2z" />
                <path d="m146.4 198.6 34.4 16.7-4.7-39.9z" />
              </g>
              <g fill="#d5bfb2" stroke="#d5bfb2" transform="translate(76 198)">
                <path d="m106.8 17.3-34.4-16.7 2.8 22.4-.3 9.5z" />
                <path d="m.1 17.3 32 15.2-.2-9.5 2.7-22.4z" />
              </g>
              <path
                d="m108.7 160.6-28.6-8.4 20.2-9.3z"
                fill="#233447"
                stroke="#233447"
              />
              <path
                d="m150.3 160.6 8.4-17.7 20.3 9.3z"
                fill="#233447"
                stroke="#233447"
              />
              <g fill="#cc6228" stroke="#cc6228" transform="translate(49 128)">
                <path d="m27.1 87.3 5-41.2-31.8.9z" />
                <path d="m128.9 46.1 4.9 41.2 26.9-40.3z" />
                <path d="m153 .7-57 2.6 5.3 29.3 8.4-17.7 20.3 9.3z" />
                <path d="m31.1 24.2 20.2-9.3 8.4 17.7 5.3-29.3-57-2.6z" />
              </g>
              <g fill="#e27525" stroke="#e27525" transform="translate(57 128)">
                <path d="m0 .7 23.9 46.7-.8-23.2z" />
                <path d="m122 24.2-.9 23.2 23.9-46.7z" />
                <path d="m57 3.3-5.3 29.3 6.7 34.6 1.5-45.6z" />
                <path d="m88 3.3-2.8 18.2 1.4 45.7 6.7-34.6z" />
              </g>
              <path
                d="m150.3 160.6-6.7 34.6 4.8 3.4 29.7-23.2.9-23.2z"
                fill="#f5841f"
                stroke="#f5841f"
              />
              <path
                d="m80.1 152.2.8 23.2 29.7 23.2 4.8-3.4-6.7-34.6z"
                fill="#f5841f"
                stroke="#f5841f"
              />
              <path
                d="m150.9 230.5.3-9.5-2.6-2.2h-38.2l-2.5 2.2.2 9.5-32-15.2 11.2 9.2 22.7 15.7h38.9l22.8-15.7 11.1-9.2z"
                fill="#c0ac9d"
                stroke="#c0ac9d"
              />
              <path
                d="m148.4 198.6-4.8-3.4h-28.2l-4.8 3.4-2.7 22.4 2.5-2.2h38.2l2.6 2.2z"
                fill="#161616"
                stroke="#161616"
              />
              <g fill="#763e1a" stroke="#763e1a">
                <path d="m250.4 80.1 8.5-41.4-12.8-38.5-97.7 72.5 37.6 31.8 53.1 15.5 11.7-13.7-5.1-3.7 8.1-7.4-6.2-4.8 8.1-6.2z" />
                <path d="m.1 38.7 8.6 41.4-5.5 4.1 8.2 6.2-6.2 4.8 8.1 7.4-5.1 3.7 11.7 13.7 53.1-15.5 37.6-31.8-97.7-72.5z" />
              </g>
              <g fill="#f5841f" stroke="#f5841f">
                <path d="m239.1 120-53.1-15.5 16 24.2-23.9 46.7 31.6-.4h47.2z" />
                <path d="m73 104.5-53.1 15.5-17.7 55h47.1l31.6.4-23.9-46.7z" />
                <path d="m145 131.3 3.4-58.6 15.4-41.7h-68.6l15.4 41.7 3.4 58.6 1.3 18.4.1 45.5h28.2l.1-45.5z" />
              </g>
            </g>
          </g>
        </svg>
      `;

      waymontSelector.addEventListener("click", function() {
        resolve(true);
      });

      metamaskSelector.addEventListener("click", function() {
        resolve(false);
      });

      let css = document.createElement("style");
      css.innerHTML = "#waymont-selector-waymont:hover, #waymont-selector-metamask:hover { background-color: #f9fafb; }";

      document.body.appendChild(css);
      popup.appendChild(waymontSelector);
      popup.appendChild(metamaskSelector);
      overlay.appendChild(popup);
      document.body.appendChild(overlay);
    });
  }

  /**
   * Internal RPC method. Forwards requests to background via the RPC engine.
   * Also remap ids inbound and outbound.
   *
   * @param payload - The RPC request object.
   * @param callback - The consumer's callback.
   */
  protected _rpcRequest(
    payload: UnvalidatedJsonRpcRequest | UnvalidatedJsonRpcRequest[],
    callback: (...args: any[]) => void,
  ) {
    let cb = callback;

    if (this._originalMetaMask !== undefined && payload.method === "eth_requestAccounts" && !(await this._confirmWaymontMetaMaskSelector())) {
      this._setWaymontTarget(this._originalMetaMask);
      (async function() {
        try {
          const { method, params } = payload;
          let res = await window.ethereum.request({ method, params });
          cb(undefined, res);
        } catch (err: any) {
          cb(err);
        }
      })();
      return;
    }

    if (!Array.isArray(payload)) {
      if (!payload.jsonrpc) {
        payload.jsonrpc = '2.0';
      }

      if (
        payload.method === 'eth_accounts' ||
        payload.method === 'eth_requestAccounts'
      ) {
        // handle accounts changing
        cb = (err: Error, res: JsonRpcSuccess<string[]>) => {
          this._handleAccountsChanged(
            res.result || [],
            payload.method === 'eth_accounts',
          );
          callback(err, res);
        };
      }
      return this._rpcEngine.handle(payload as JsonRpcRequest<unknown>, cb);
    }
    return this._rpcEngine.handle(payload as JsonRpcRequest<unknown>[], cb);
  }

  /**
   * When the provider becomes connected, updates internal state and emits
   * required events. Idempotent.
   *
   * @param chainId - The ID of the newly connected chain.
   * @emits MetaMaskInpageProvider#connect
   */
  protected _handleConnect(chainId: string) {
    if (!this._state.isConnected) {
      this._state.isConnected = true;
      this.emit('connect', { chainId });
      this._log.debug(messages.info.connected(chainId));
    }
  }

  /**
   * When the provider becomes disconnected, updates internal state and emits
   * required events. Idempotent with respect to the isRecoverable parameter.
   *
   * Error codes per the CloseEvent status codes as required by EIP-1193:
   * https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent#Status_codes
   *
   * @param isRecoverable - Whether the disconnection is recoverable.
   * @param errorMessage - A custom error message.
   * @emits BaseProvider#disconnect
   */
  protected _handleDisconnect(isRecoverable: boolean, errorMessage?: string) {
    if (
      this._state.isConnected ||
      (!this._state.isPermanentlyDisconnected && !isRecoverable)
    ) {
      this._state.isConnected = false;

      let error;
      if (isRecoverable) {
        error = new EthereumRpcError(
          1013, // Try again later
          errorMessage || messages.errors.disconnected(),
        );
        this._log.debug(error);
      } else {
        error = new EthereumRpcError(
          1011, // Internal error
          errorMessage || messages.errors.permanentlyDisconnected(),
        );
        this._log.error(error);
        this.chainId = null;
        this._state.accounts = null;
        this.selectedAddress = null;
        this._state.isUnlocked = false;
        this._state.isPermanentlyDisconnected = true;
      }

      this.emit('disconnect', error);
    }
  }

  /**
   * Upon receipt of a new `chainId`, emits the corresponding event and sets
   * and sets relevant public state. Does nothing if the given `chainId` is
   * equivalent to the existing value.
   *
   * Permits the `networkVersion` field in the parameter object for
   * compatibility with child classes that use this value.
   *
   * @emits BaseProvider#chainChanged
   * @param networkInfo - An object with network info.
   * @param networkInfo.chainId - The latest chain ID.
   */
  protected _handleChainChanged({
    chainId,
  }: { chainId?: string; networkVersion?: string } = {}) {
    if (!isValidChainId(chainId)) {
      this._log.error(messages.errors.invalidNetworkParams(), { chainId });
      return;
    }

    this._handleConnect(chainId);

    if (chainId !== this.chainId) {
      this.chainId = chainId;
      if (this._state.initialized) {
        this.emit('chainChanged', this.chainId);
      }
    }
  }

  /**
   * Called when accounts may have changed. Diffs the new accounts value with
   * the current one, updates all state as necessary, and emits the
   * accountsChanged event.
   *
   * @param accounts - The new accounts value.
   * @param isEthAccounts - Whether the accounts value was returned by
   * a call to eth_accounts.
   */
  protected _handleAccountsChanged(
    accounts: unknown[],
    isEthAccounts = false,
  ): void {
    let _accounts = accounts;

    if (!Array.isArray(accounts)) {
      this._log.error(
        'MetaMask: Received invalid accounts parameter. Please report this bug.',
        accounts,
      );
      _accounts = [];
    }

    for (const account of accounts) {
      if (typeof account !== 'string') {
        this._log.error(
          'MetaMask: Received non-string account. Please report this bug.',
          accounts,
        );
        _accounts = [];
        break;
      }
    }

    // emit accountsChanged if anything about the accounts array has changed
    if (!dequal(this._state.accounts, _accounts)) {
      // we should always have the correct accounts even before eth_accounts
      // returns
      if (isEthAccounts && this._state.accounts !== null) {
        this._log.error(
          `MetaMask: 'eth_accounts' unexpectedly updated accounts. Please report this bug.`,
          _accounts,
        );
      }

      this._state.accounts = _accounts as string[];

      // handle selectedAddress
      if (this.selectedAddress !== _accounts[0]) {
        this.selectedAddress = (_accounts[0] as string) || null;
      }

      // finally, after all state has been updated, emit the event
      if (this._state.initialized) {
        this.emit('accountsChanged', _accounts);
      }
    }
  }

  /**
   * Upon receipt of a new isUnlocked state, sets relevant public state.
   * Calls the accounts changed handler with the received accounts, or an empty
   * array.
   *
   * Does nothing if the received value is equal to the existing value.
   * There are no lock/unlock events.
   *
   * @param opts - Options bag.
   * @param opts.accounts - The exposed accounts, if any.
   * @param opts.isUnlocked - The latest isUnlocked value.
   */
  protected _handleUnlockStateChanged({
    accounts,
    isUnlocked,
  }: { accounts?: string[]; isUnlocked?: boolean } = {}) {
    if (typeof isUnlocked !== 'boolean') {
      this._log.error(
        'MetaMask: Received invalid isUnlocked parameter. Please report this bug.',
      );
      return;
    }

    if (isUnlocked !== this._state.isUnlocked) {
      this._state.isUnlocked = isUnlocked;
      this._handleAccountsChanged(accounts || []);
    }
  }
}
