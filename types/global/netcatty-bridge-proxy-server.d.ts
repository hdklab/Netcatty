declare global {
  interface NetcattyBridge {
    /**
     * Start the local proxy server (SOCKS5 + HTTP on one port) so other devices
     * on the network can use this machine as their proxy.
     */
    startLocalProxyServer?(options: {
      /** '127.0.0.1' for local-only, '0.0.0.0' to accept LAN clients. */
      bindHost: string;
      port: number;
      upstream?: import("../../domain/localProxyServer").LocalProxyUpstream | null;
      auth?: import("../../domain/localProxyServer").LocalProxyAuth | null;
    }): Promise<{
      success: boolean;
      status?: import("../../domain/localProxyServer").LocalProxyServerStatus;
      /** 'invalid-port' | 'port-in-use' | 'permission-denied' | 'listen-failed' | ... */
      error?: string;
      detail?: string;
    }>;
    stopLocalProxyServer?(): Promise<import("../../domain/localProxyServer").LocalProxyServerStatus>;
    getLocalProxyServerStatus?(): Promise<import("../../domain/localProxyServer").LocalProxyServerStatus>;
    /** Status frames pushed by the main process (coalesced). Returns an unsubscribe. */
    onLocalProxyServerStatus?(
      listener: (status: import("../../domain/localProxyServer").LocalProxyServerStatus) => void,
    ): () => void;
  }
}

export {};
