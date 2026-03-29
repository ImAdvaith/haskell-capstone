{-# LANGUAGE OverloadedStrings #-}

import Web.Scotty
import Network.Wai.Middleware.RequestLogger (logStdoutDev)
import Control.Monad.IO.Class (liftIO)
import Data.IORef
import Data.List (lookup, intercalate)
import Data.String (fromString)

type DHT = IORef [(String, [String])]  -- Hash Table: file_hash -> [peer_ip]

upsert :: String -> String -> [(String, [String])] -> [(String, [String])]
upsert hash ip [] = [(hash, [ip])]
upsert hash ip ((h, ips):xs)
    | hash == h =
        if ip `elem` ips
            then (h, ips) : xs
            else (h, ips ++ [ip]) : xs
    | otherwise = (h, ips) : upsert hash ip xs

main :: IO ()
main = do
    dhtRef <- newIORef []
    putStrLn "DHT Node started on port 8080..."
    scotty 8080 $ do
        middleware logStdoutDev

        -- Store a file hash with the peer's IP
        post "/store/:hash/:ip" $ do
            hash <- pathParam "hash" :: ActionM String
            ip <- pathParam "ip" :: ActionM String
            liftIO $ modifyIORef dhtRef (upsert hash ip)
            text $ "Stored " <> (fromString hash) <> " -> " <> (fromString ip)

        -- Retrieve one peer IP by file hash (backward compatible)
        get "/get/:hash" $ do
            hash <- pathParam "hash" :: ActionM String
            dht <- liftIO $ readIORef dhtRef
            case lookup hash dht of
                Just (ip:_) -> text (fromString ip)
                Just [] -> text "Not found"
                Nothing -> text "Not found"

        -- Retrieve all peers for a file hash as comma-separated list
        get "/getall/:hash" $ do
            hash <- pathParam "hash" :: ActionM String
            dht <- liftIO $ readIORef dhtRef
            case lookup hash dht of
                Just ips -> text (fromString (intercalate "," ips))
                Nothing -> text "Not found"
