import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch } from 'react-redux';
import { SniperConfig as SniperConfigType, addSniperConfig, updateSniperConfig, deleteSniperConfig } from '../store/slices/sniperConfigsSlice';
import { Plus, Trash2, Save, Zap, Target, Timer, DollarSign, AlertCircle, ChevronDown, ChevronUp, X, Wallet, Settings, Play, Square } from 'lucide-react';
import { Button } from '../components/ui/button';
import AutoSnipeControls from '../components/AutoSnipeControls';
import { Connection, VersionedTransaction, Keypair, PublicKey } from '@solana/web3.js';
import { startSnipe } from '../lib/sniperService';
import toast from '../lib/toast-shim';
import { useNavigate } from 'react-router-dom';
import { useManagedWallets } from '../hooks/useManagedWallets';
import { useAuthenticatedSniperConfigs } from '../hooks/useSimpleAuth';
import { useAuth } from '../contexts/AuthContext';
import { getRaydiumQuote, getRaydiumSwapTransaction } from '../lib/raydium';

/**
 * Main SniperConfig component - only rendered when authenticated
 * All hooks are called unconditionally since authentication is handled by wrapper
 */
const SniperConfigMain: React.FC = () => {
  // ALL HOOKS CALLED UNCONDITIONALLY - NO AUTHENTICATION CHECKS HERE
  const { sessionToken } = useAuth();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const sniperConfigs = useAuthenticatedSniperConfigs();

  // Use managed wallets hook
  const {
    wallets: managedWallets,
    activeWallet,
    loading: loadingManagedWallets,
    error: managedWalletError,
    setActiveWallet,
    refetch: refetchWallets
  } = useManagedWallets();

  // ALL STATE HOOKS MUST BE CALLED UNCONDITIONALLY
  const [expandedConfig, setExpandedConfig] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [pendingSnipeConfig, setPendingSnipeConfig] = useState<SniperConfigType | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [configToDelete, setConfigToDelete] = useState<string | null>(null);
  const [newConfig, setNewConfig] = useState({
    name: '',
    tokenAddress: '',
    buyAmount: '',
    sellTarget: '',
    stopLoss: '',
    maxSlippage: '1',
    tokenType: 'sol' as 'sol' | 'wsol', // Default to SOL
    dex: 'jupiter' as 'jupiter' | 'raydium',
    autoApprove: false,
    gasLimit: '200000',
    walletId: '', // Add walletId field

    // Advanced Fee Management
    priorityFee: '0.001', // Default 0.001 SOL priority fee
    bribeFee: '0.001', // Default 0.001 SOL bribe fee
    autoFeeMode: true, // Enable auto-fee by default
    baseFeeMultiplier: '1.5', // 1.5x multiplier for faster execution

    // MEV Protection
    mevProtection: true, // Enable MEV protection by default
    jitoTipAmount: '0.01', // Default Jito tip amount

    // Advanced Trading Options
    maxSlippageAdvanced: '40', // 40% advanced slippage as you suggested
    slippageMode: 'aggressive' as 'conservative' | 'aggressive' | 'custom',
    frontrunProtection: true,
    sandwichProtection: true,

    notifications: {
      telegram: false,
      email: false,
    },
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showWalletSelector, setShowWalletSelector] = useState(false);
  const [selectedWalletId, setSelectedWalletId] = useState<string>('');
  const [activeSnipes, setActiveSnipes] = useState<any[]>([]); // Track active snipes

  // Trade confirmation modal state
  const [showTradeConfirmation, setShowTradeConfirmation] = useState(false);
  const [pendingTradeConfig, setPendingTradeConfig] = useState<SniperConfigType | null>(null);
  const [pendingTradeWallet, setPendingTradeWallet] = useState<any>(null);
  const [isExecutingTrade, setIsExecutingTrade] = useState(false);

  // Get current wallet balance from active managed wallet - memoize to prevent unnecessary re-renders
  const currentWalletBalance = useMemo(() => activeWallet?.balance || 0, [activeWallet?.balance]);
  const isWalletConnected = useMemo(() => !!activeWallet, [activeWallet]);

  // Get selected wallet object from ID
  const selectedWallet = useMemo(() => {
    return managedWallets.find(wallet => wallet.id === selectedWalletId);
  }, [managedWallets, selectedWalletId]);

  // Solana connection for transactions
  const connection = new Connection(process.env.REACT_APP_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

  // ALL useCallback AND useEffect HOOKS MUST BE CALLED UNCONDITIONALLY
  const executeSnipe = useCallback(async (config: SniperConfigType, configuredWallet?: any) => {
    console.log("executeSnipe called with config:", config);
    console.log("executeSnipe called with wallet:", configuredWallet);

    // Use the configuredWallet if provided, otherwise fall back to activeWallet
    const walletToUse = configuredWallet || activeWallet;

    if (!walletToUse) {
      toast.error('No wallet available for trading');
      return;
    }

    try {
      // Ensure tokenType and dex are present
      const updatedConfig = {
        ...config,
        tokenType: config.tokenType || 'sol',
        dex: config.dex || 'jupiter',
      };

      // Execute the actual trade
      toast.info(`🚀 Executing trade for "${config.name}" with ${walletToUse.name}...`);

      const tradeResult = await executeImmediateTrade(updatedConfig, walletToUse);

      if (tradeResult.success) {
        const successResult = tradeResult as { success: true; signature: string; amountOut: string };
        toast.success(`✅ Trade executed successfully! ${successResult.signature ? `TX: ${successResult.signature.substring(0, 8)}...` : ''}`);

        // Refresh wallet balance after trade
        setTimeout(async () => {
          try {
            await fetch(`/api/wallets/${walletToUse.id}/balance`, { method: 'POST' });
          } catch (error) {
            console.warn('Failed to refresh wallet balance:', error);
          }
        }, 1000);

        // Redirect to transactions page after 2 seconds
        setTimeout(() => {
          console.log('Redirecting to transactions page');
          navigate('/transactions?new=true');
        }, 2000);
      } else {
        const errorResult = tradeResult as { success: false; error: string };
        toast.error(`❌ Trade failed: ${errorResult.error}`);
      }
    } catch (error) {
      console.error('Error executing snipe:', error);
      toast.error('Failed to execute trade');
    }
  }, [activeWallet, navigate]); // Add dependencies

  // Effect to handle executing a snipe after wallet connection
  useEffect(() => {
    if (isWalletConnected && pendingSnipeConfig) {
      // Wallet has been connected, now execute the pending snipe
      const checkBalance = () => {
        const buyAmount = parseFloat(pendingSnipeConfig.buyAmount) || 0;
        const tokenType = pendingSnipeConfig.tokenType || 'sol';

        if (tokenType === 'sol') {
          const totalNeeded = buyAmount + 0.005;
          return (currentWalletBalance !== null) && (currentWalletBalance >= totalNeeded);
        }
        return false;
      };

      if (!checkBalance()) {
        toast.error("Insufficient balance after connecting.");
        setPendingSnipeConfig(null);
        return;
      }

      // Execute snipe with the active wallet (this is for manual wallet selection)
      executeSnipe(pendingSnipeConfig, activeWallet);
      setPendingSnipeConfig(null);
    }
  }, [isWalletConnected, pendingSnipeConfig, currentWalletBalance]); // Remove executeSnipe from deps to prevent render loops

  // Check if new configuration can be saved
  const canSaveConfig = (): boolean => {
    const isTokenAddressValid = newConfig.tokenAddress.length > 0;
    const isBuyAmountValid = parseFloat(newConfig.buyAmount) > 0;
    const isWalletSelected = selectedWalletId.length > 0;
    return !!newConfig.name && isTokenAddressValid && isBuyAmountValid && isWalletSelected;
  };

  const handleAddConfig = () => {
    if (canSaveConfig()) {
      dispatch(addSniperConfig({
        ...newConfig,
        id: Date.now().toString(),
        dex: newConfig.dex,
        walletId: selectedWalletId // Include the selected wallet ID
      }));
      setNewConfig({
        name: '',
        tokenAddress: '',
        buyAmount: '',
        sellTarget: '',
        stopLoss: '',
        maxSlippage: '1',
        tokenType: 'sol',
        dex: 'jupiter',
        autoApprove: false,
        gasLimit: '200000',
        walletId: '', // Reset walletId

        // Advanced Fee Management - Reset to defaults
        priorityFee: '0.001',
        bribeFee: '0.001',
        autoFeeMode: true,
        baseFeeMultiplier: '1.5',

        // MEV Protection - Reset to defaults
        mevProtection: true,
        jitoTipAmount: '0.01',

        // Advanced Trading Options - Reset to defaults
        maxSlippageAdvanced: '40',
        slippageMode: 'aggressive',
        frontrunProtection: true,
        sandwichProtection: true,

        notifications: {
          telegram: false,
          email: false,
        },
      });
      setSelectedWalletId(''); // Reset wallet selection
      setIsModalOpen(false);
    }
  };

  const handleUpdateConfig = (id: string, updates: Partial<SniperConfigType>) => {
    dispatch(updateSniperConfig({ id, updates }));
  };

  const handleDeleteConfig = (id: string) => {
    dispatch(deleteSniperConfig(id));
    // Ensure expanded view is closed if the deleted config was expanded
    if (expandedConfig === id) {
      setExpandedConfig(null);
    }
  };

  const openDeleteConfirmation = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfigToDelete(id);
    setIsDeleteModalOpen(true);
  };

  const confirmDelete = () => {
    if (configToDelete) {
      handleDeleteConfig(configToDelete);
      setConfigToDelete(null);
      setIsDeleteModalOpen(false);
    }
  };

  // Check if the user has enough balance for a transaction
  const hasEnoughBalance = (config: SniperConfigType): boolean => {
    const buyAmount = parseFloat(config.buyAmount) || 0;
    const tokenType = config.tokenType || 'sol'; // Default to 'sol' if not provided

    console.log("Checking balance:", { currentWalletBalance, buyAmount, tokenType });

    if (tokenType === 'sol') {
      // Check if balance is sufficient for the order (buy amount + 0.005 SOL for fees)
      const totalNeeded = buyAmount + 0.005;
      const result = (currentWalletBalance !== null) && (currentWalletBalance >= totalNeeded);

      if (!result && currentWalletBalance !== null) {
        setErrorMessage(`Insufficient SOL balance. You have ${currentWalletBalance?.toFixed(6)} SOL but need ${totalNeeded.toFixed(6)} SOL (${buyAmount} + 0.005 fees).`);
      }

      console.log("Balance check result (SOL):", result, { currentWalletBalance, totalNeeded });
      return result;
    } else {
      // wSOL not supported yet
      setErrorMessage("wSOL trading not yet supported. Please use SOL.");
      return false;
    }
  };

  // Function to refresh wallet balances from backend
  const refreshBalances = async () => {
    try {
      // FIX (slop audit P0): endpoint is refresh-all-balances — the old path 404'd silently
      const response = await fetch('/api/wallets/refresh-all-balances', {
        method: 'POST',
      });

      if (response.ok) {
        // Refetch wallets to get updated balances
        await refetchWallets();
        console.log('✅ Wallet balances refreshed successfully');
      } else {
        console.error('Failed to refresh balances');
      }
    } catch (error) {
      console.error('Error refreshing balances:', error);
    }
  };

  const handleSnipe = async (config: SniperConfigType) => {
    // Clear previous error messages
    setErrorMessage(null);

    // Debug log
    console.log("handleSnipe called for config:", config);
    console.log("Config walletId:", config.walletId);

    // Check if config has a walletId stored
    if (!config.walletId) {
      console.log("No walletId in config, this might be a legacy config. Showing wallet selector");
      setPendingSnipeConfig(config);
      setShowWalletSelector(true);
      return;
    }

    // Find the wallet from the stored walletId
    const configWallet = managedWallets.find(wallet => wallet.id === config.walletId);
    if (!configWallet) {
      console.log("Stored wallet not found, showing wallet selector");
      setErrorMessage(`The wallet configured for this sniper (${config.walletId}) was not found. Please select a different wallet.`);
      setPendingSnipeConfig(config);
      setShowWalletSelector(true);
      return;
    }

    console.log(`🎯 Using configured wallet: ${configWallet.name} (${configWallet.balance?.toFixed(4)} SOL)`);

    // Check balance with the configured wallet
    const walletBalance = configWallet.balance || 0;
    const requiredAmount = parseFloat(config.buyAmount);

    if (walletBalance < requiredAmount) {
      const tokenTypeLabel = config.tokenType === 'sol' ? 'SOL' : 'wSOL';
      setErrorMessage(`Insufficient ${tokenTypeLabel} balance in wallet "${configWallet.name}". You have ${walletBalance.toFixed(4)} ${tokenTypeLabel} but need ${requiredAmount} ${tokenTypeLabel}.`);
      toast.error(errorMessage || "Insufficient balance");
      return;
    }

    // Show confirmation modal instead of executing immediately
    setPendingTradeConfig(config);
    setPendingTradeWallet(configWallet);
    setShowTradeConfirmation(true);
  };

  // Confirm and execute trade after user confirmation
  const confirmAndExecuteTrade = async () => {
    if (!pendingTradeConfig || !pendingTradeWallet) return;

    setIsExecutingTrade(true);
    try {
      await executeSnipe(pendingTradeConfig, pendingTradeWallet);
    } finally {
      setIsExecutingTrade(false);
      setShowTradeConfirmation(false);
      setPendingTradeConfig(null);
      setPendingTradeWallet(null);
    }
  };

  // Calculate estimated fees for display
  const calculateEstimatedFees = (config: SniperConfigType | null): { priorityFee: number; networkFee: number; total: number } => {
    if (!config) return { priorityFee: 0, networkFee: 0, total: 0 };

    const priorityFee = config.autoFeeMode ? 0.001 * parseFloat(config.baseFeeMultiplier || '1.5') : parseFloat(config.priorityFee || '0.001');
    const networkFee = 0.000005; // Approximate network fee
    const total = priorityFee + networkFee;

    return { priorityFee, networkFee, total };
  };

  // Trading execution function
  const executeImmediateTrade = async (config: SniperConfigType, managedWallet: any) => {
    try {
      console.log('🚀 Starting immediate trade execution with managed wallet');
      console.log('Config:', config);
      console.log('Managed Wallet:', managedWallet.name);
      console.log('Selected DEX:', config.dex);

      // Validate config
      if (!config.tokenAddress || !config.buyAmount) {
        throw new Error('Token address and buy amount are required');
      }

      // Validate token liquidity before proceeding
      console.log('🔍 Validating token liquidity...');
      await validateTokenLiquidity(config.tokenAddress);
      console.log('✅ Token validation passed');

      // Validate amounts
      const buyAmountFloat = parseFloat(config.buyAmount);
      if (isNaN(buyAmountFloat) || buyAmountFloat <= 0) {
        throw new Error('Invalid buy amount');
      }

      // Execute based on selected DEX with automatic fallback
      let result;
      if (config.dex === 'raydium') {
        console.log('🔵 Using Raydium DEX');
        try {
          result = await executeRaydiumSwapWithManagedWallet(config, managedWallet);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          // If Raydium fails due to no route, automatically try Jupiter as fallback
          if (errorMessage.includes('ROUTE_NOT_FOUND') || errorMessage.includes('not tradable on Raydium')) {
            console.log('🪐 Raydium failed, falling back to Jupiter DEX...');
            toast.info('⚠️ Raydium has no liquidity for this token, trying Jupiter as fallback...');
            result = await executeJupiterSwapWithManagedWallet(config, managedWallet);
          } else {
            throw error; // Re-throw other errors
          }
        }
      } else {
        console.log('🪐 Using Jupiter DEX (default)');
        result = await executeJupiterSwapWithManagedWallet(config, managedWallet);
      }

      return result;
    } catch (error) {
      console.error('Trade execution error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  };

  // Function to get token name from token address
  const getTokenName = async (tokenAddress: string): Promise<string> => {
    try {
      const response = await fetch(`/api/token-info/${tokenAddress}`);
      if (response.ok) {
        const data = await response.json();
        if (data.pairs && data.pairs.length > 0) {
          // Try to get token name from pairs
          const pair = data.pairs[0];
          if (pair.baseToken && pair.baseToken.address === tokenAddress) {
            return pair.baseToken.symbol || pair.baseToken.name || tokenAddress.slice(-6);
          }
          if (pair.quoteToken && pair.quoteToken.address === tokenAddress) {
            return pair.quoteToken.symbol || pair.quoteToken.name || tokenAddress.slice(-6);
          }
        }
      }
    } catch (error) {
      console.warn('Failed to get token name:', error);
    }
    // Fallback to last 6 characters of address
    return tokenAddress.slice(-6);
  };

  // Token validation and liquidity check
  const validateTokenLiquidity = async (tokenAddress: string) => {
    try {
      // Check if token has any trading pairs on DexScreener
      const response = await fetch(`/api/token-info/${tokenAddress}`);
      if (!response.ok) {
        throw new Error('Failed to fetch token information');
      }

      const tokenData = await response.json();
      if (!tokenData.pairs || tokenData.pairs.length === 0) {
        throw new Error(`Token ${tokenAddress} has no active trading pairs or liquidity. This token may not be tradeable yet.`);
      }

      return true;
    } catch (error) {
      console.error('Token validation error:', error);
      throw error;
    }
  };

  // Jupiter swap execution with managed wallet
  const executeJupiterSwapWithManagedWallet = async (config: SniperConfigType, managedWallet: any) => {
    try {
      console.log('🪐 Executing Jupiter buy with managed wallet via /api/wallets/buy-token');

      const solAmount = parseFloat(config.buyAmount);
      const slippageBps = parseInt(config.maxSlippage) * 100;
      const outputMint = 'So11111111111111111111111111111111111111112'; // SOL (will be input for buying)

      console.log(`SOL Amount: ${solAmount}`);
      console.log(`Token: ${config.tokenAddress}`);
      console.log(`Slippage: ${config.maxSlippage}% (${slippageBps} bps)`);
      console.log(`Wallet: ${managedWallet.name} (${managedWallet.publicKey})`);

      // Use our buy-token endpoint which handles Jupiter integration AND database recording
      const buyResponse = await fetch('/api/wallets/buy-token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          walletId: managedWallet.id,
          tokenMint: config.tokenAddress,
          solAmount: solAmount,
          outputMint: outputMint,
          slippageBps: slippageBps,
          dex: 'jupiter'
        })
      });

      if (!buyResponse.ok) {
        const errorData = await buyResponse.json();
        const errorMsg = errorData.error || 'Failed to execute buy transaction';

        if (errorMsg.includes('not tradable') || errorMsg.includes('No route found')) {
          throw new Error(`Token ${config.tokenAddress} is not tradable on Jupiter. This could be because:\n- Token has insufficient liquidity\n- Token is not yet listed on exchanges\n- Token address is invalid\n\nPlease verify the token address and try again.`);
        }

        throw new Error(errorMsg);
      }

      const result = await buyResponse.json();
      console.log(`✅ Jupiter buy transaction successful! Signature: ${result.signature}`);

      return {
        success: true,
        signature: result.signature,
        amountOut: result.estimatedTokens || 'Unknown'
      };

    } catch (error) {
      console.error('Jupiter buy error:', error);
      throw error;
    }
  };

  // Raydium swap execution with managed wallet
  const executeRaydiumSwapWithManagedWallet = async (config: SniperConfigType, managedWallet: any) => {
    try {
      console.log('🔵 Executing Raydium buy with managed wallet via /api/wallets/buy-token');

      const solAmount = parseFloat(config.buyAmount);
      const slippageBps = parseInt(config.maxSlippage) * 100;
      const outputMint = 'So11111111111111111111111111111111111111112'; // SOL (will be input for buying)

      console.log(`SOL Amount: ${solAmount}`);
      console.log(`Token: ${config.tokenAddress}`);
      console.log(`Slippage: ${config.maxSlippage}% (${slippageBps} bps)`);
      console.log(`Wallet: ${managedWallet.name} (${managedWallet.publicKey})`);

      // Use our buy-token endpoint which handles Raydium integration AND database recording
      const buyResponse = await fetch('/api/wallets/buy-token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          walletId: managedWallet.id,
          tokenMint: config.tokenAddress,
          solAmount: solAmount,
          outputMint: outputMint,
          slippageBps: slippageBps,
          dex: 'raydium'
        })
      });

      if (!buyResponse.ok) {
        const errorData = await buyResponse.json();
        const errorMsg = errorData.error || 'Failed to execute buy transaction';

        if (errorMsg.includes('not tradable') || errorMsg.includes('No route found') || errorMsg.includes('ROUTE_NOT_FOUND')) {
          throw new Error(`Token ${config.tokenAddress} is not tradable on Raydium. This could be because:\n- Token has no Raydium liquidity pool\n- Token is not yet listed on Raydium\n- Token address is invalid\n\nFalling back to Jupiter DEX...`);
        }

        throw new Error(errorMsg);
      }

      const result = await buyResponse.json();
      console.log(`✅ Raydium buy transaction successful! Signature: ${result.signature}`);

      return {
        success: true,
        signature: result.signature,
        amountOut: result.estimatedTokens || 'Unknown'
      };

    } catch (error) {
      console.error('Raydium buy error:', error);
      throw error;
    }
  };

  // Load active snipes on component mount
  useEffect(() => {
    const fetchActiveSnipes = async () => {
      try {
        const response = await fetch('/api/active-snipes', {
          headers: {
            'Authorization': `Bearer ${sessionToken}`,
            'Content-Type': 'application/json'
          }
        });

        if (response.ok) {
          const data = await response.json();
          setActiveSnipes(data.activeSnipes || []);
        }
      } catch (error) {
        console.error('Failed to fetch active snipes:', error);
      }
    };

    if (sessionToken) {
      fetchActiveSnipes();
    }
  }, [sessionToken]);

  // Check if a config has an active snipe
  const isConfigActive = (configId: string) => {
    return activeSnipes.some(snipe => snipe.configId === configId && snipe.status === 'monitoring');
  };

  // Get active snipe for a config
  const getActiveSnipe = (configId: string) => {
    return activeSnipes.find(snipe => snipe.configId === configId && snipe.status === 'monitoring');
  };

  // Activate sniper (start monitoring)
  const handleActivateSniper = async (config: SniperConfigType) => {
    try {
      const response = await fetch('/api/active-snipes/start', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sessionToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ configId: config.id, configData: config })
      });

      const data = await response.json();

      if (response.ok) {
        toast.success(`🎯 Sniper "${config.name}" activated and monitoring!`);
        // Add to local state
        setActiveSnipes(prev => [...prev, data.activeSnipe]);
      } else {
        toast.error(data.error || 'Failed to activate sniper');
      }
    } catch (error) {
      console.error('Error activating sniper:', error);
      toast.error('Failed to activate sniper');
    }
  };

  // Deactivate sniper (stop monitoring)
  const handleDeactivateSniper = async (config: SniperConfigType) => {
    const activeSnipe = getActiveSnipe(config.id);
    if (!activeSnipe) return;

    try {
      const response = await fetch('/api/active-snipes/stop', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sessionToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ activeSnipeId: activeSnipe.id })
      });

      const data = await response.json();

      if (response.ok) {
        toast.success(`🛑 Sniper "${config.name}" deactivated`);
        // Remove from local state
        setActiveSnipes(prev => prev.filter(snipe => snipe.id !== activeSnipe.id));
      } else {
        toast.error(data.error || 'Failed to deactivate sniper');
      }
    } catch (error) {
      console.error('Error deactivating sniper:', error);
      toast.error('Failed to deactivate sniper');
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="w-full max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            {/* Page title lives in SniperPage (merged page, audit §2) — this is the Targets tab */}
            <h2 className="text-lg font-semibold">Per-Token Targets</h2>
            <p className="text-sm text-muted-foreground mt-1">Configure your token sniping strategies</p>
          </div>
          <button
            onClick={() => {
              console.log("New Sniper button clicked");
              setIsModalOpen(true);
            }}
            className="modern-button solana-glow flex items-center"
          >
            <Plus className="w-4 h-4 mr-2" />
            New Sniper
          </button>
        </div>

        {/* Error message */}
        {errorMessage && (
          <div className="glass p-4 rounded-xl mb-6 border border-red-500 bg-red-500/10">
            <div className="flex items-center">
              <AlertCircle className="w-5 h-5 text-red-500 mr-2 flex-shrink-0" />
              <span className="text-red-500 font-medium">{errorMessage}</span>
            </div>
          </div>
        )}

        {/* Auto-Snipe Controls */}
        <div className="mb-8">
          <AutoSnipeControls />
        </div>

        {/* Divider */}
        <div className="border-t border-border my-8">
          <div className="flex items-center justify-center -mt-3">
            <span className="bg-background px-4 text-sm text-muted-foreground">Manual Snipers</span>
          </div>
        </div>

        {/* Wallet selector overlay */}
        {showWalletSelector && (
          <div className="fixed inset-0 bg-black/90 backdrop-blur-sm flex items-center justify-center z-50">
            <div className="glass p-6 rounded-xl w-full max-w-md mx-4 animate-scale-in">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold gradient-text">Select Trading Wallet</h2>
                <button
                  onClick={() => setShowWalletSelector(false)}
                  className="p-2 rounded-lg hover:bg-accent/10 transition-colors duration-200"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-3">
                {managedWallets.map((wallet) => (
                  <button
                    key={wallet.id}
                    onClick={() => {
                      setActiveWallet(wallet.id); // Pass wallet ID, not wallet object
                      setShowWalletSelector(false);
                    }}
                    className="w-full p-3 rounded-lg glass hover:bg-accent/10 transition-colors duration-200 text-left"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">{wallet.name}</div>
                        <div className="text-sm text-muted-foreground">
                          {wallet.publicKey.slice(0, 8)}...{wallet.publicKey.slice(-8)}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-medium">{wallet.balance?.toFixed(6) || '0'} SOL</div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Sniper configurations list */}
        <div className="space-y-4">
          {sniperConfigs.length === 0 ? (
            <div className="glass p-8 rounded-xl text-center">
              <Target className="w-12 h-12 mx-auto mb-4 text-primary" />
              <h3 className="text-lg font-semibold mb-2">No Sniper Configurations</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Create your first sniper configuration to start automated trading
              </p>
              <button
                onClick={() => setIsModalOpen(true)}
                className="modern-button solana-glow flex items-center mx-auto"
              >
                <Plus className="w-4 h-4 mr-2" />
                Create New Sniper
              </button>
            </div>
          ) : (
            sniperConfigs.map((config: SniperConfigType) => (
              <div key={config.id} className="glass p-4 rounded-xl border border-border">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                      <Target className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold">{config.name}</h3>
                      <p className="text-sm text-muted-foreground">
                        {config.tokenAddress.slice(0, 8)}...{config.tokenAddress.slice(-8)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    {/* Show active sniper status */}
                    {isConfigActive(config.id) && (
                      <div className="flex items-center text-green-500 text-xs">
                        <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse mr-1"></div>
                        MONITORING
                      </div>
                    )}

                    {/* Activate/Deactivate Sniper Button */}
                    {isConfigActive(config.id) ? (
                      <Button
                        onClick={() => handleDeactivateSniper(config)}
                        className="bg-orange-600 hover:bg-orange-700 text-white"
                      >
                        <Square className="w-4 h-4 mr-1" />
                        Stop
                      </Button>
                    ) : (
                      <Button
                        onClick={() => handleActivateSniper(config)}
                        className="bg-blue-600 hover:bg-blue-700 text-white"
                      >
                        <Play className="w-4 h-4 mr-1" />
                        Activate
                      </Button>
                    )}

                    {/* Immediate Buy Button */}
                    <Button
                      onClick={() => handleSnipe(config)}
                      className="bg-green-600 hover:bg-green-700 text-white"
                    >
                      <Zap className="w-4 h-4 mr-1" />
                      Buy Now
                    </Button>

                    <button
                      onClick={(e) => openDeleteConfirmation(config.id, e)}
                      className="p-2 rounded-lg hover:bg-red-500/10 hover:text-red-500 transition-colors duration-200"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* New Config Modal — portaled to <body>: ancestors with transforms
            (animate-fade-in etc.) hijack position:fixed and center the modal on
            the PAGE instead of the viewport */}
        {isModalOpen && createPortal(
          <div className="fixed inset-0 bg-black/90 backdrop-blur-sm flex items-center justify-center z-50">
            <div className="glass p-6 rounded-xl w-full max-w-2xl mx-4 animate-scale-in max-h-[90vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold gradient-text">Create New Sniper</h2>
                <button
                  onClick={() => setIsModalOpen(false)}
                  className="p-2 rounded-lg hover:bg-accent/10 transition-colors duration-200"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-4">
                {/* Wallet Selector */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">Select Wallet</label>
                  <select
                    value={selectedWalletId}
                    onChange={(e) => setSelectedWalletId(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-background/50 border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                  >
                    <option value="">Select a wallet...</option>
                    {managedWallets.map(wallet => (
                      <option key={wallet.id} value={wallet.id}>
                        {wallet.name} ({wallet.balance?.toFixed(4) || '0.0000'} SOL)
                      </option>
                    ))}
                  </select>
                  {managedWallets.length === 0 && (
                    <p className="text-sm text-yellow-500">
                      ⚠️ No wallets found. Create a wallet first in the Wallet Manager.
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Name</label>
                  <input
                    type="text"
                    value={newConfig.name}
                    onChange={(e) => setNewConfig({ ...newConfig, name: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg bg-background/50 border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                    placeholder="Enter sniper name"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Token Address</label>
                  <input
                    type="text"
                    value={newConfig.tokenAddress}
                    onChange={(e) => setNewConfig({ ...newConfig, tokenAddress: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg bg-background/50 border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                    placeholder="Enter token contract address"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Buy Amount (SOL)</label>
                    <input
                      type="number"
                      value={newConfig.buyAmount}
                      onChange={(e) => setNewConfig({ ...newConfig, buyAmount: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-background/50 border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                      placeholder="0.1"
                      step="0.01"
                      min="0"
                    />
                    {selectedWalletId && (
                      <span className={parseFloat(newConfig.buyAmount) > (selectedWallet?.balance || 0) ? 'text-red-500' : 'text-green-500'}>
                        Balance: {(selectedWallet?.balance || 0).toFixed(4)} SOL
                      </span>
                    )}
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">Max Slippage (%)</label>
                    <input
                      type="number"
                      value={newConfig.maxSlippage}
                      onChange={(e) => setNewConfig({ ...newConfig, maxSlippage: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-background/50 border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                      placeholder="1"
                      step="0.1"
                      min="0.1"
                      max="50"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">DEX</label>
                  <select
                    value={newConfig.dex}
                    onChange={(e) => setNewConfig({ ...newConfig, dex: e.target.value as 'jupiter' | 'raydium' })}
                    className="w-full px-3 py-2 rounded-lg bg-background/50 border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                  >
                    <option value="jupiter">Jupiter (Recommended)</option>
                    <option value="raydium">Raydium</option>
                  </select>
                </div>

                {/* Advanced Fee Management */}
                <div className="space-y-4 bg-gradient-to-r from-purple-500/10 to-blue-500/10 p-4 rounded-lg border border-purple-500/20">
                  <div className="flex items-center space-x-2">
                    <Zap className="w-4 h-4 text-yellow-500" />
                    <label className="text-sm font-medium text-yellow-400">Advanced Fee Management</label>
                  </div>

                  <div className="flex items-center space-x-3">
                    <input
                      type="checkbox"
                      id="autoFeeMode"
                      checked={newConfig.autoFeeMode}
                      onChange={(e) => setNewConfig({ ...newConfig, autoFeeMode: e.target.checked })}
                      className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
                    />
                    <div className="flex flex-col">
                      <label htmlFor="autoFeeMode" className="text-sm text-green-400">Auto Fee Mode (Recommended)</label>
                      <span className="text-xs text-muted-foreground">Automatically calculates optimal fees for fastest execution</span>
                    </div>
                  </div>

                  {!newConfig.autoFeeMode && (
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Priority Fee (SOL)</label>
                        <input
                          type="number"
                          step="0.001"
                          value={newConfig.priorityFee}
                          onChange={(e) => setNewConfig({ ...newConfig, priorityFee: e.target.value })}
                          className="w-full px-3 py-2 rounded-lg bg-background/50 border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                          placeholder="0.001"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Bribe Fee (SOL)</label>
                        <input
                          type="number"
                          step="0.001"
                          value={newConfig.bribeFee}
                          onChange={(e) => setNewConfig({ ...newConfig, bribeFee: e.target.value })}
                          className="w-full px-3 py-2 rounded-lg bg-background/50 border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                          placeholder="0.001"
                        />
                      </div>
                    </div>
                  )}

                  {newConfig.autoFeeMode && (
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Base Fee Multiplier</label>
                      <select
                        value={newConfig.baseFeeMultiplier}
                        onChange={(e) => setNewConfig({ ...newConfig, baseFeeMultiplier: e.target.value })}
                        className="w-full px-3 py-2 rounded-lg bg-background/50 border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                      >
                        <option value="1.0">Conservative (1.0x)</option>
                        <option value="1.5">Balanced (1.5x)</option>
                        <option value="2.0">Aggressive (2.0x)</option>
                        <option value="3.0">Ultra Fast (3.0x)</option>
                      </select>
                    </div>
                  )}
                </div>

                {/* MEV Protection */}
                <div className="space-y-4 bg-gradient-to-r from-green-500/10 to-emerald-500/10 p-4 rounded-lg border border-green-500/20">
                  <div className="flex items-center space-x-2">
                    <Target className="w-4 h-4 text-green-500" />
                    <label className="text-sm font-medium text-green-400">MEV Protection (Jito Bundles)</label>
                  </div>

                  <div className="flex items-center space-x-3">
                    <input
                      type="checkbox"
                      id="mevProtection"
                      checked={newConfig.mevProtection}
                      onChange={(e) => setNewConfig({ ...newConfig, mevProtection: e.target.checked })}
                      className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
                    />
                    <div className="flex flex-col">
                      <label htmlFor="mevProtection" className="text-sm text-green-400">Enable MEV Protection</label>
                      <span className="text-xs text-muted-foreground">Protects against front-running and sandwich attacks using Jito bundles</span>
                    </div>
                  </div>

                  {newConfig.mevProtection && (
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Jito Tip Amount (SOL)</label>
                      <input
                        type="number"
                        step="0.001"
                        value={newConfig.jitoTipAmount}
                        onChange={(e) => setNewConfig({ ...newConfig, jitoTipAmount: e.target.value })}
                        className="w-full px-3 py-2 rounded-lg bg-background/50 border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                        placeholder="0.01"
                      />
                      <span className="text-xs text-muted-foreground">Higher tips increase bundle priority</span>
                    </div>
                  )}
                </div>

                {/* Advanced Slippage & Protection */}
                <div className="space-y-4 bg-gradient-to-r from-orange-500/10 to-red-500/10 p-4 rounded-lg border border-orange-500/20">
                  <div className="flex items-center space-x-2">
                    <AlertCircle className="w-4 h-4 text-orange-500" />
                    <label className="text-sm font-medium text-orange-400">Advanced Trading Protection</label>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">Slippage Mode</label>
                    <select
                      value={newConfig.slippageMode}
                      onChange={(e) => setNewConfig({ ...newConfig, slippageMode: e.target.value as 'conservative' | 'aggressive' | 'custom' })}
                      className="w-full px-3 py-2 rounded-lg bg-background/50 border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                    >
                      <option value="conservative">Conservative (1-5%)</option>
                      <option value="aggressive">Aggressive (10-40%)</option>
                      <option value="custom">Custom</option>
                    </select>
                  </div>

                  {newConfig.slippageMode === 'aggressive' && (
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Max Slippage Advanced (%)</label>
                      <input
                        type="number"
                        value={newConfig.maxSlippageAdvanced}
                        onChange={(e) => setNewConfig({ ...newConfig, maxSlippageAdvanced: e.target.value })}
                        className="w-full px-3 py-2 rounded-lg bg-background/50 border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                        placeholder="40"
                      />
                      <span className="text-xs text-orange-400">⚠️ High slippage for volatile/new tokens</span>
                    </div>
                  )}

                  <div className="space-y-3">
                    <div className="flex items-center space-x-3">
                      <input
                        type="checkbox"
                        id="frontrunProtection"
                        checked={newConfig.frontrunProtection}
                        onChange={(e) => setNewConfig({ ...newConfig, frontrunProtection: e.target.checked })}
                        className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
                      />
                      <label htmlFor="frontrunProtection" className="text-sm">Front-run Protection</label>
                    </div>
                    <div className="flex items-center space-x-3">
                      <input
                        type="checkbox"
                        id="sandwichProtection"
                        checked={newConfig.sandwichProtection}
                        onChange={(e) => setNewConfig({ ...newConfig, sandwichProtection: e.target.checked })}
                        className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
                      />
                      <label htmlFor="sandwichProtection" className="text-sm">Sandwich Attack Protection</label>
                    </div>
                  </div>
                </div>

                {/* Options */}
                <div className="space-y-3 bg-background/50 p-4 rounded-lg border border-border">
                  <label className="text-sm font-medium">Options</label>
                  <div className="space-y-3">
                    <div className="flex items-center space-x-3">
                      <input
                        type="checkbox"
                        id="autoApprove"
                        checked={newConfig.autoApprove}
                        onChange={(e) => setNewConfig({ ...newConfig, autoApprove: e.target.checked })}
                        className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
                      />
                      <div className="flex flex-col">
                        <label htmlFor="autoApprove" className="text-sm">Auto-approve transactions</label>
                        <span className="text-xs text-muted-foreground">Note: Some wallets may still show approval for security</span>
                      </div>
                    </div>
                    <div className="flex items-center space-x-3">
                      <input
                        type="checkbox"
                        id="telegramNotif"
                        checked={newConfig.notifications.telegram}
                        onChange={(e) => setNewConfig({
                          ...newConfig,
                          notifications: { ...newConfig.notifications, telegram: e.target.checked }
                        })}
                        className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
                      />
                      <label htmlFor="telegramNotif" className="text-sm">Telegram notifications</label>
                    </div>
                    <div className="flex items-center space-x-3">
                      <input
                        type="checkbox"
                        id="emailNotif"
                        checked={newConfig.notifications.email}
                        onChange={(e) => setNewConfig({
                          ...newConfig,
                          notifications: { ...newConfig.notifications, email: e.target.checked }
                        })}
                        className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
                      />
                      <label htmlFor="emailNotif" className="text-sm">Email notifications</label>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end space-x-3 pt-4">
                  <button
                    onClick={() => setIsModalOpen(false)}
                    className="px-4 py-2 rounded-lg border border-border hover:bg-accent/10 transition-colors duration-200"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleAddConfig}
                    disabled={!canSaveConfig()}
                    className="px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200"
                  >
                    Create Sniper
                  </button>
                </div>
              </div>
            </div>
          </div>
        , document.body)}

        {/* Delete Confirmation Modal (portaled — see above) */}
        {isDeleteModalOpen && createPortal(
          <div className="fixed inset-0 bg-black/90 backdrop-blur-sm flex items-center justify-center z-50">
            <div className="glass p-6 rounded-xl w-full max-w-md mx-4 animate-scale-in">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-red-500">Delete Sniper</h2>
                <button
                  onClick={() => setIsDeleteModalOpen(false)}
                  className="p-2 rounded-lg hover:bg-accent/10 transition-colors duration-200"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <p className="text-muted-foreground mb-6">
                Are you sure you want to delete this sniper configuration? This action cannot be undone.
              </p>

              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => setIsDeleteModalOpen(false)}
                  className="px-4 py-2 rounded-lg border border-border hover:bg-accent/10 transition-colors duration-200"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmDelete}
                  className="px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors duration-200"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        , document.body)}

        {/* Trade Confirmation Modal (portaled — see above) */}
        {showTradeConfirmation && pendingTradeConfig && createPortal(
          <div className="fixed inset-0 bg-black/90 backdrop-blur-sm flex items-center justify-center z-50">
            <div className="glass p-6 rounded-xl w-full max-w-md mx-4 animate-scale-in">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-green-400 flex items-center gap-2">
                  <Zap className="w-5 h-5" />
                  Confirm Trade
                </h2>
                <button
                  onClick={() => {
                    setShowTradeConfirmation(false);
                    setPendingTradeConfig(null);
                    setPendingTradeWallet(null);
                  }}
                  className="p-2 rounded-lg hover:bg-accent/10 transition-colors duration-200"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-4">
                {/* Warning Banner */}
                <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
                  <div className="flex items-center text-yellow-500 text-sm">
                    <AlertCircle className="w-4 h-4 mr-2 flex-shrink-0" />
                    <span>Please review the trade details carefully before confirming</span>
                  </div>
                </div>

                {/* Trade Details */}
                <div className="bg-background/50 rounded-lg p-4 space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Token</span>
                    <span className="font-mono text-sm">
                      {pendingTradeConfig.tokenAddress.slice(0, 8)}...{pendingTradeConfig.tokenAddress.slice(-8)}
                    </span>
                  </div>

                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Amount</span>
                    <span className="font-bold text-lg text-green-400">
                      {pendingTradeConfig.buyAmount} {pendingTradeConfig.tokenType?.toUpperCase() || 'SOL'}
                    </span>
                  </div>

                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">DEX</span>
                    <span className="font-medium">{pendingTradeConfig.dex?.toUpperCase() || 'JUPITER'}</span>
                  </div>

                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Slippage</span>
                    <span className="font-medium">{pendingTradeConfig.maxSlippage}%</span>
                  </div>

                  <div className="border-t border-border pt-3 mt-3">
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-muted-foreground">Est. Priority Fee</span>
                      <span>{calculateEstimatedFees(pendingTradeConfig).priorityFee.toFixed(6)} SOL</span>
                    </div>
                    <div className="flex justify-between items-center text-sm mt-1">
                      <span className="text-muted-foreground">Network Fee</span>
                      <span>~{calculateEstimatedFees(pendingTradeConfig).networkFee.toFixed(6)} SOL</span>
                    </div>
                    <div className="flex justify-between items-center font-bold mt-2 pt-2 border-t border-border">
                      <span>Total (incl. fees)</span>
                      <span className="text-green-400">
                        {(parseFloat(pendingTradeConfig.buyAmount) + calculateEstimatedFees(pendingTradeConfig).total).toFixed(6)} SOL
                      </span>
                    </div>
                  </div>

                  {pendingTradeWallet && (
                    <div className="bg-primary/5 rounded-lg p-3 mt-2">
                      <div className="text-xs text-muted-foreground mb-1">Trading from</div>
                      <div className="font-medium">{pendingTradeWallet.name}</div>
                      <div className="text-sm text-muted-foreground">
                        Balance: {pendingTradeWallet.balance?.toFixed(4) || '0.0000'} SOL
                      </div>
                    </div>
                  )}
                </div>

                {/* Action Buttons */}
                <div className="flex space-x-3 pt-2">
                  <button
                    onClick={() => {
                      setShowTradeConfirmation(false);
                      setPendingTradeConfig(null);
                      setPendingTradeWallet(null);
                    }}
                    disabled={isExecutingTrade}
                    className="flex-1 px-4 py-3 border border-border rounded-lg hover:bg-accent/10 transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmAndExecuteTrade}
                    disabled={isExecutingTrade}
                    className="flex-1 px-4 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-bold transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {isExecutingTrade ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                        Executing...
                      </>
                    ) : (
                      <>
                        <Zap className="w-4 h-4" />
                        CONFIRM BUY
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        , document.body)}
      </div>
    </div>
  );
};

export default SniperConfigMain;
