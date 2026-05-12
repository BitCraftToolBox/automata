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
    var region = Environment.GetEnvironmentVariable("BITCRAFT_REGION_MODULE") ?? "bitcraft-2";
    var token = Environment.GetEnvironmentVariable("BITCRAFT_BEARER_TOKEN");
    var dataDir = Environment.GetEnvironmentVariable("DATA_DIR") ?? "workspace/data/cereal-cs";
    Directory.CreateDirectory(dataDir);

    if (string.IsNullOrEmpty(host))
    {
        throw new Exception("Missing required environment variable BITCRAFT_SPACETIME_HOST.");
    }

    var tables = await GetStaticTableNames(host, region, dataDir);

    var staticDir = Path.Combine(dataDir, "static");
    Directory.CreateDirectory(staticDir);

    DbConnection? conn = null;
    var cancellationTokenSource = new CancellationTokenSource();
    conn = ConnectToDatabase(cancellationTokenSource, host, region, token, tables, staticDir);
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

async Task<Dictionary<string, string>> GetStaticTableNames(string host, string module, string dataDir)
{
    using var client = new HttpClient();
    var response = await client.GetAsync($"https://{host}/v1/database/{module}/schema?version=9");
    if (!response.IsSuccessStatusCode)
    {
        throw new Exception($"Failed to download schema for {module}: {response.StatusCode}");
    }

    var content = await response.Content.ReadAsStringAsync();
    var schema = JsonConvert.DeserializeObject<JObject>(content);
    if (schema == null || !schema.TryGetValue("tables", out var tableArray))
    {
        throw new Exception("Invalid schema format: 'tables' field not found");
    }

    // Sort row_level_security by sql to avoid spurious diffs
    if (schema.TryGetValue("row_level_security", out var rlsToken) && rlsToken is JArray rls)
    {
        var sorted = new JArray(rls.OrderBy(item => item["sql"]?.ToString()));
        schema["row_level_security"] = sorted;
    }

    var schemaPath = Path.Combine(dataDir, "region_schema.json");
    File.WriteAllText(schemaPath, schema.ToString(Formatting.Indented));

    var schemaTypes =
        schema.TryGetValue("typespace", out var typespaceToken) && typespaceToken is JObject typespace 
            && typespace.TryGetValue("types", out var typesToken) && typesToken is JArray types
        ? types.ToObject<List<Dictionary<string, object>>>()
        : null;
    if (schemaTypes == null)
    {
        throw new Exception("Invalid schema format: typespace or types field not found or not in expected format.");
    }

    // Extract the types JArray for later use in GetPrimaryKey
    JArray? typesArray = null;
    if (schema.TryGetValue("typespace", out var typespaceTokenTemp) && typespaceTokenTemp is JObject typespaceTemp
        && typespaceTemp.TryGetValue("types", out var typesTokenTemp) && typesTokenTemp is JArray typesArrayTemp)
    {
        typesArray = typesArrayTemp;
    }

    var schemaTables = ((JArray) tableArray).ToObject<List<Dictionary<string, object>>>();
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
    
    // Build a map of table name to (primary_key_index, product_type_ref)
    var tableMap = new Dictionary<string, (int pkIdx, long typeRef)>();
    foreach (var table in tables)
    {
        var tableEntry = ((JArray) tableArray).FirstOrDefault(t => (string) t["name"]! == table);
        if (tableEntry == null) continue;
        var primaryKey = (int) tableEntry["primary_key"]![0]!;
        var productTypeRef = (long) tableEntry["product_type_ref"]!;
        tableMap[table] = (primaryKey, productTypeRef);
    }

    return tables.ToDictionary(name => name, GetPrimaryKey);

    string GetPrimaryKey(string tableName)
    {
        if (!tableMap.TryGetValue(tableName, out var tableInfo))
        {
            return "";
        }

        if (typesArray == null || tableInfo.typeRef < 0 || tableInfo.typeRef >= typesArray.Count)
        {
            return "";
        }

        if (typesArray[(int)tableInfo.typeRef] is not JObject typeObj || !typeObj.TryGetValue("Product", out var productToken) || productToken is not JObject product)
        {
            return "";
        }

        if (!product.TryGetValue("elements", out var elementsToken) || elementsToken is not JArray elements)
        {
            return "";
        }

        if (tableInfo.pkIdx < 0 || tableInfo.pkIdx >= elements.Count)
        {
            return "";
        }

        if (elements[tableInfo.pkIdx] is not JObject element || !element.TryGetValue("name", out var nameToken) || nameToken is not JObject nameObj)
        {
            return "";
        }

        if (nameObj.TryGetValue("some", out var nameValue))
        {
            return (string?) nameValue ?? "";
        }

        return "";
    }
}

DbConnection ConnectToDatabase(CancellationTokenSource token, string host, string region, string? bearerToken, Dictionary<string, string> tables, string dataDir)
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

void OnConnected(DbConnection conn, Dictionary<string, string> tables, string dataDir)
{
    var queries = tables
        .Select(table => $"SELECT * FROM {table.Key};")
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

void OnSubscriptionApplied(SubscriptionEventContext ctx, Dictionary<string, string> tables, string dataDir)
{
    var converters = new StringEnumConverter();

    var getTableMethod = ReflectTables(ctx.Db);
    foreach (var (table, sortKey) in tables)
    {
        var tblHandle = getTableMethod.Invoke(ctx.Db, [table])!;
        var getIterMethod = ReflectIterator(tblHandle);
        var tblIter = getIterMethod.Invoke(tblHandle, [])!;

        var array = JArray.FromObject(tblIter, JsonSerializer.CreateDefault(new JsonSerializerSettings { Converters = [converters] }));

        if (array.Count > 0)
        {
            if (!string.IsNullOrEmpty(sortKey))
            {
                var sorted = array.OrderBy(item => item[sortKey]?.ToObject<object>());
                array = new JArray(sorted);
            }

            if (table.Equals("building_function_type_mapping_desc"))
            {
                foreach (var obj in array)
                {
                    obj["desc_ids"] = new JArray(obj["desc_ids"]!.OrderBy(id => id.ToObject<int>()));
                }
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
