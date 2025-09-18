using System.Reflection;
using System.Text.RegularExpressions;
using BitCraftRegion.Types;
using dotenv.net;
using Newtonsoft.Json;
using Newtonsoft.Json.Converters;
using Newtonsoft.Json.Linq;

DotEnv.Load(new DotEnvOptions(envFilePaths: ["../../.env.local", "../../../../../.env.local"]));

try
{
    await Main();
}
catch (Exception ex)
{
    Console.WriteLine(ex);
}

return;

async Task Main()
{
    // Get environment variables
    var host = Environment.GetEnvironmentVariable("BITCRAFT_SPACETIME_HOST");
    var region = Environment.GetEnvironmentVariable("BITCRAFT_REGION") ?? "bitcraft-2";
    var token = Environment.GetEnvironmentVariable("BITCRAFT_BEARER_TOKEN");
    var dataDir = Environment.GetEnvironmentVariable("DATA_DIR") ?? "workspace/data/cereal-cs";
    Directory.CreateDirectory(dataDir);

    if (string.IsNullOrEmpty(host))
    {
        throw new Exception("Missing required environment variable BITCRAFT_SPACETIME_HOST.");
    }

    var tables = await GetStaticTableNames(host, region);

    DbConnection? conn = null;
    var cancellationTokenSource = new CancellationTokenSource();
    conn = ConnectToDatabase(cancellationTokenSource, host, region, token, tables, dataDir);
    var thread = new Thread(() => ProcessThread(conn, cancellationTokenSource.Token));
    thread.Start();
    thread.Join();

    var gho = Environment.GetEnvironmentVariable("GITHUB_OUTPUT");
    if (!string.IsNullOrEmpty(gho)) {
        File.AppendAllText(gho, "updated_data=true");
    }
}

void ProcessThread(DbConnection conn, CancellationToken ct)
{
    try
    {
        while (!ct.IsCancellationRequested)
        {
            conn.FrameTick();
            Thread.Sleep(100);
        }
    }
    finally
    {
        conn.Disconnect();
    }
}

async Task<string[]> GetStaticTableNames(string host, string module)
{
    using var client = new HttpClient();
    var response = await client.GetAsync($"https://{host}/v1/database/{module}/schema?version=9");
    if (!response.IsSuccessStatusCode)
    {
        throw new Exception($"Failed to download schema for {module}: {response.StatusCode}");
    }

    var content = await response.Content.ReadAsStringAsync();
    var schema = JsonConvert.DeserializeObject<Dictionary<string, object>>(content);
    if (schema == null || !schema.TryGetValue("tables", out var value))
    {
        throw new Exception("Invalid schema format: 'tables' field not found");
    }

    var schemaTables = ((JArray) value).ToObject<List<Dictionary<string, object>>>();
    if (schemaTables == null)
    {
        throw new Exception("Invalid schema format: tables wasn't a list of dictionaries.");
    }

    var descRegex = new Regex("_desc(_v\\d+)?$");
    var extraTables = new[] { "claim_tile_cost" };
    var tables = schemaTables
        .Where(t => ((JObject) t["table_access"]).ContainsKey("Public"))
        .Select(t => (string) t["name"])
        .Where(name => !string.IsNullOrEmpty(name))
        .Where(name => !name.EndsWith("_state"))
        .Where(name => descRegex.IsMatch(name) || Array.IndexOf(extraTables, name) > -1)
        .ToArray();

    return tables;
}

DbConnection ConnectToDatabase(CancellationTokenSource token, string host, string region, string? bearerToken, string[] tables, string dataDir)
{
    DbConnection? conn = null;
    conn = DbConnection.Builder()
        .WithUri("https://" + host)
        .WithModuleName(region)
        .WithToken(bearerToken)
        .OnConnect((c, _, _) => OnConnected(c, tables, dataDir))
        .OnConnectError(OnConnectError)
        .OnDisconnect((_, err) =>
        {
            OnDisconnected(err);
            token.Cancel();
        })
        .Build();
    return conn;
}

void OnConnected(DbConnection conn, string[] tables, string dataDir)
{
    var queries = tables
        .Select(table => $"SELECT * FROM {table};")
        .ToArray();

    conn.SubscriptionBuilder()
        .OnApplied(ctx => OnSubscriptionApplied(ctx, tables, dataDir))
        .Subscribe(queries);
}

MethodInfo ReflectTables(RemoteTables remoteTables)
{
    var methodInfo = remoteTables.GetType().BaseType?.GetMethod("GetTable",
        BindingFlags.NonPublic | BindingFlags.Instance,
        null, [typeof(string)], null);

    if (methodInfo == null)
    {
        throw new Exception("GetTable method not found in RemoteTablesBase");
    }

    return methodInfo;
}

MethodInfo ReflectIterator(object handle)
{
    var methodInfo = handle.GetType().BaseType?.GetMethod("Iter");

    if (methodInfo == null)
    {
        throw new Exception("Iter method not found in RemoteTableHandle");
    }

    return methodInfo;
}

void OnSubscriptionApplied(SubscriptionEventContext ctx, string[] tables, string dataDir)
{
    var converters = new StringEnumConverter();
    var sortKeys = new[] { "id", "item_id", "building_id", "name", "cargo_id", "type_id" };


    var getTableMethod = ReflectTables(ctx.Db);
    foreach (var table in tables)
    {
        var tblHandle = getTableMethod.Invoke(ctx.Db, [table])!;
        var getIterMethod = ReflectIterator(tblHandle);
        var tblIter = getIterMethod.Invoke(tblHandle, [])!;

        var array = JArray.FromObject(tblIter, JsonSerializer.CreateDefault(new JsonSerializerSettings { Converters = [converters] }));

        if (array.Count > 0)
        {
            // Find the first key that exists in the objects
            var sortKey = sortKeys.FirstOrDefault(key => array[0][key] != null);

            if (sortKey != null)
            {
                var sorted = array.OrderBy(item => item[sortKey]?.ToObject<object>());
                array = new JArray(sorted);
            }
        }

        File.WriteAllText($"{dataDir}/{table}.json", JsonConvert.SerializeObject(array, Formatting.Indented));
    }

    ctx.Disconnect();
}

void OnConnectError(Exception e)
{
    Console.Write($"Error while connecting: {e}");
}

void OnDisconnected(Exception? e)
{
    Console.Write(e != null ? $"Disconnected abnormally: {e}" : "Disconnected normally.");
}
