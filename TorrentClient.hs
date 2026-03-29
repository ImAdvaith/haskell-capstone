import Control.Concurrent (forkIO)
import Control.Concurrent.MVar (MVar, newEmptyMVar, putMVar, takeMVar)
import Data.List (dropWhileEnd)
import Data.List (isPrefixOf)
import System.Exit (ExitCode(..))
import System.Process (readProcess)
import System.Process (readProcessWithExitCode)

trimTrailingNewline :: String -> String
trimTrailingNewline = dropWhileEnd (`elem` ['\n', '\r'])

splitByComma :: String -> [String]
splitByComma [] = []
splitByComma s = token : case rest of
    [] -> []
    (_:xs) -> splitByComma xs
  where
    (token, rest) = break (== ',') s

trimSpaces :: String -> String
trimSpaces = dropWhile isTrimChar . dropWhileEnd isTrimChar
    where
        isTrimChar c = c == ' ' || c == '\t' || c == '\r' || c == '\n'

fetchPeers :: String -> IO [String]
fetchPeers fileHash = do
    let getAllUrl = "http://127.0.0.1:8080/getall/" ++ fileHash
    peersRaw <- fmap trimTrailingNewline (readProcess "curl" ["-s", getAllUrl] "")
    if peersRaw == "Not found" || null peersRaw
        then do
            let getOneUrl = "http://127.0.0.1:8080/get/" ++ fileHash
            peer <- fmap trimTrailingNewline (readProcess "curl" ["-s", getOneUrl] "")
            if peer == "Not found" || null peer
                then pure []
                else pure [peer]
        else pure (filter (not . null) (map trimSpaces (splitByComma peersRaw)))

contentLengthFromHeaders :: String -> Maybe Int
contentLengthFromHeaders rawHeaders =
    parseContentLength (lines rawHeaders)
  where
    parseContentLength [] = Nothing
    parseContentLength (line:xs)
        | "Content-Length:" `isPrefixOf` line =
            case reads (trimSpaces (drop (length "Content-Length:") line)) of
                [(n, "")] -> Just n
                _ -> parseContentLength xs
        | otherwise = parseContentLength xs

getFileSize :: String -> IO (Maybe Int)
getFileSize fileUrl = do
    headers <- readProcess "curl" ["-sI", fileUrl] ""
    pure (contentLengthFromHeaders headers)

isPeerHealthy :: String -> String -> IO Bool
isPeerHealthy peer fileHash = do
    let url = "http://" ++ peer ++ "/" ++ fileHash
    (code, _, _) <- readProcessWithExitCode "curl" ["-sI", "--fail", url] ""
    pure (code == ExitSuccess)

filterHealthyPeers :: String -> [String] -> IO [String]
filterHealthyPeers fileHash peers = do
    pairs <- mapM check peers
    pure [peer | (peer, True) <- pairs]
  where
    check peer = do
        healthy <- isPeerHealthy peer fileHash
        pure (peer, healthy)

chunkRanges :: Int -> Int -> [(Int, Int)]
chunkRanges totalSize chunkSize = go 0
  where
    go start
        | start >= totalSize = []
        | otherwise =
            let end = min (totalSize - 1) (start + chunkSize - 1)
             in (start, end) : go (end + 1)

downloadRange :: String -> (Int, Int) -> FilePath -> IO (Either String FilePath)
downloadRange fileUrl (start, end) outPath = do
    let byteCount = end - start + 1
    let script =
            "set -e; " ++
            "curl -sS --fail \"$1\" | tail -c +$(( $2 + 1 )) | head -c \"$3\" > \"$4\"; " ++
            "actual=$(wc -c < \"$4\"); " ++
            "[ \"$actual\" -eq \"$3\" ]"
    (code, stdOut, errOut) <- readProcessWithExitCode
        "sh"
        ["-c", script, "--", fileUrl, show start, show byteCount, outPath]
        ""
    case code of
        ExitSuccess -> pure (Right outPath)
        ExitFailure n ->
            let details =
                    "chunk fetch failed (exit " ++ show n ++ ")" ++
                    " url=" ++ fileUrl ++
                    " range=" ++ show start ++ "-" ++ show end ++
                    (if null errOut then "" else " stderr=" ++ trimTrailingNewline errOut) ++
                    (if null stdOut then "" else " stdout=" ++ trimTrailingNewline stdOut)
             in pure (Left details)

safeRemove :: FilePath -> IO ()
safeRemove path = do
        _ <- readProcessWithExitCode "rm" ["-f", path] ""
        pure ()

mergeChunks :: [FilePath] -> FilePath -> IO ()
mergeChunks chunkFiles finalPath = do
        _ <- readProcessWithExitCode "sh" ["-c", "cat " ++ unwords (map quote chunkFiles) ++ " > " ++ quote finalPath] ""
        pure ()
    where
        quote s = "\"" ++ s ++ "\""

downloadParallel :: String -> IO ()
downloadParallel fileHash = do
    peers <- fetchPeers fileHash
    healthyPeers <- filterHealthyPeers fileHash peers
    if null healthyPeers
        then putStrLn "File not found in DHT."
        else do
            let basePeer = head healthyPeers
            let fileUrlForSize = "http://" ++ basePeer ++ "/" ++ fileHash
            sizeMaybe <- getFileSize fileUrlForSize
            case sizeMaybe of
                Nothing -> putStrLn "Unable to determine file size from peer headers."
                Just totalSize -> do
                    let perChunkSize = 262144  -- 256 KB
                    let ranges = chunkRanges totalSize perChunkSize
                    let tasks = zip [0 ..] ranges
                    doneVars <- mapM (const newEmptyMVar) tasks

                    mapM_ (spawnWorker fileHash healthyPeers doneVars) tasks

                    chunkResults <- mapM takeMVar doneVars
                    case sequence chunkResults of
                        Left errMsg -> do
                            putStrLn "Download failed while fetching chunks."
                            putStrLn errMsg
                            mapM_ safeRemove [fileHash ++ ".part" ++ show idx | (idx, _) <- tasks]
                        Right chunkFiles -> do
                            mergeChunks chunkFiles fileHash
                            putStrLn "Download completed successfully."
                            mapM_ safeRemove chunkFiles
  where
    spawnWorker fileHash peers doneVars (idx, range) = do
        let peer = peers !! (idx `mod` length peers)
        let fileUrl = "http://" ++ peer ++ "/" ++ fileHash
        let outPath = fileHash ++ ".part" ++ show idx
        let doneVar = doneVars !! idx
        _ <- forkIO $ do
            result <- downloadRange fileUrl range outPath
            putMVar doneVar result
        pure ()

main :: IO ()
main = do
    putStrLn "Enter file hash to download:"
    fileHash <- getLine
    downloadParallel fileHash
