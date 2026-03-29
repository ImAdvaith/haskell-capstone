{-# LANGUAGE OverloadedStrings #-}

import System.Environment
import System.Process (callCommand, readProcess)

-- Register a file in the DHT
registerFile :: String -> String -> IO ()
registerFile fileHash ip = do
    let url = "http://127.0.0.1:8080/store/" ++ fileHash ++ "/" ++ ip
    callCommand $ "curl -s -X POST " ++ url ++ " > /dev/null"
    putStrLn $ "Registered file " ++ fileHash ++ " at " ++ ip

-- Find a peer for a file hash
findPeer :: String -> IO ()
findPeer fileHash = do
    let url = "http://127.0.0.1:8080/get/" ++ fileHash
    body <- readProcess "curl" ["-s", url] ""
    putStrLn $ "Peer for " ++ fileHash ++ ": " ++ body

-- Find all peers for a file hash
findAllPeers :: String -> IO ()
findAllPeers fileHash = do
    let url = "http://127.0.0.1:8080/getall/" ++ fileHash
    body <- readProcess "curl" ["-s", url] ""
    putStrLn $ "Peers for " ++ fileHash ++ ": " ++ body

main :: IO ()
main = do
    args <- getArgs
    case args of
        ["register", fileHash, ip] -> registerFile fileHash ip
        ["find", fileHash] -> findPeer fileHash
        ["findall", fileHash] -> findAllPeers fileHash
        _ -> putStrLn "Usage: Peer register <fileHash> <ip> | find <fileHash> | findall <fileHash>"
