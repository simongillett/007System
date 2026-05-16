/**
 * Unified error response format for the trading system.
 * All error responses follow this consistent structure.
 */

export interface TradingSystemError {
  code: string;
  message: string;
  details: {
    agentId?: string;
    taskType?: string;
    transactionHash?: string;
    amount?: string;
    limit?: string;
    missingFields?: string[];
    originalRequest?: object;
  };
  timestamp: string;
  correlationId: string;
}
