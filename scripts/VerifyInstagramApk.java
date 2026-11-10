import com.android.apksig.ApkVerifier;
import com.android.apksig.internal.apk.AndroidBinXmlParser;
import java.io.File;
import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.zip.ZipFile;

class VerifyInstagramApk {
  public static void main(String[] args) throws Exception {
    var result = new ApkVerifier.Builder(new File(args[0])).build().verify();
    System.out.println("VERIFIED=" + result.isVerified());
    System.out.println("ERRORS=" + result.getErrors());
    for (var cert : result.getSignerCertificates()) {
      System.out.println("CERT_SHA256=" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(cert.getEncoded())));
    }
    try (var zip = new ZipFile(args[0])) {
      var xml = new AndroidBinXmlParser(ByteBuffer.wrap(zip.getInputStream(zip.getEntry("AndroidManifest.xml")).readAllBytes()));
      for (int event = xml.getEventType(); event != AndroidBinXmlParser.EVENT_END_DOCUMENT; event = xml.next()) {
        if (event == AndroidBinXmlParser.EVENT_START_ELEMENT && "manifest".equals(xml.getName())) {
          for (int i = 0; i < xml.getAttributeCount(); i++) {
            var name = xml.getAttributeName(i);
            if (name.equals("package") || name.equals("versionName")) System.out.println(name + "=" + xml.getAttributeStringValue(i));
            if (name.equals("versionCode")) System.out.println(name + "=" + xml.getAttributeIntValue(i));
          }
          break;
        }
      }
    }
    if (!result.isVerified()) System.exit(1);
  }
}
